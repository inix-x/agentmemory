import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { execFile, spawn } from "node:child_process";
import { transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchDockerEngine } from "../src/cli/docker-engine.js";
import { createStartupStderrCapture } from "../src/cli/startup-stderr.js";
import { dockerComposeArgs } from "../src/cli/engine-launch.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));

function child() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: Object.assign(new PassThrough(), { unref: vi.fn() }),
    stderr: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn(),
  });
}

const source = readFileSync("src/cli.ts", "utf8");
const functionStart = source.indexOf("function createEngineExitHandler(");
const functionEnd = source.indexOf("const ENGINE_STARTUP_GRACE_MS", functionStart);
const graceEnd = source.indexOf(";", functionEnd) + 1;
const compiledSpawn = transpileModule(source.slice(functionStart, graceEnd), {}).outputText;

// Run the CLI's actual spawn function without executing its command dispatcher.
function cliSpawn(logEnabled = false) {
  const exit = vi.fn();
  const clearState = vi.fn();
  const writePid = vi.fn();
  const clearPid = vi.fn();
  const attachLog = vi.fn();
  const env: Record<string, string> = {};
  const factory = new Function("spawn", "watchDockerEngine", "process", "clearEngineState", "writeEnginePidfile", "clearEnginePidfile", "createStartupStderrCapture", "ENGINE_LOG_ENABLED", "attachEngineLog", `
    const vlog = () => {};
    const IS_VERBOSE = false;
    let startupFailure = null;
    let stopDockerEngineWatch;
    let activeStartupStderr = createStartupStderrCapture();
    ${compiledSpawn}
    return {
      start: spawnEngineBackground,
      watch: startDockerEngineWatch,
      failure: () => startupFailure,
      stop: () => stopDockerEngineWatch?.(),
      stderr: () => activeStartupStderr.text(),
    };
  `);
  return { ...factory(spawn, watchDockerEngine, { env, exit }, clearState, writePid, clearPid, createStartupStderrCapture, logEnabled, attachLog), exit, env, clearState, writePid, clearPid, attachLog };
}

type LookupCallback = (error: Error | null, stdout: string, stderr: string) => void;
let lookupCallback: LookupCallback;
let lookupChild: ReturnType<typeof child>;
function completeLookup(error: Error | null = null, ids = "a".repeat(64) + "\n") {
  lookupCallback(error, ids, "");
}
function finishStartup(compose: ReturnType<typeof child>) {
  compose.emit("exit", 0, null);
  completeLookup();
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  lookupChild = child();
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    lookupCallback = args[3] as LookupCallback;
    return lookupChild as never;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function startDocker() {
  const compose = child();
  const observer = child();
  vi.mocked(spawn).mockReturnValueOnce(compose as never).mockReturnValueOnce(observer as never);
  const cli = cliSpawn();
  cleanups.push(cli.stop);
  cli.start("docker", dockerComposeArgs("/own/compose.yml", "agentmemory-3121", ["up", "-d"]), "iii-engine via Docker", "/own/invocation", { composeFile: "/own/compose.yml", projectName: "agentmemory-3121" });
  return { compose, observer, cli };
}

function containerExit(observer: ReturnType<typeof child>, code: number) {
  observer.emit("exit", 0, null);
  observer.stdout.emit("data", Buffer.from(`${code}\n`));
  observer.emit("close", 0, null);
}

describe("Docker engine lifetime supervision", () => {
  it("keeps timers responsive while identity lookup is pending", () => {
    const { compose, cli } = startDocker();
    const tick = vi.fn();
    setTimeout(tick, 100);
    compose.emit("exit", 0, null);
    expect(execFile).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledOnce();
    expect(cli.exit).not.toHaveBeenCalled();
    completeLookup();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([null, new Error("lookup cancelled")])("cancels pending lookup and ignores its late callback (%s)", (error) => {
    const { compose, observer, cli } = startDocker();
    const before = process.listenerCount("exit");
    compose.emit("exit", 0, null);
    expect(process.listenerCount("exit")).toBe(before + 1);
    cli.stop();
    expect(lookupChild.kill).toHaveBeenCalledOnce();
    expect(process.listenerCount("exit")).toBe(before);
    completeLookup(error);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(compose.kill).not.toHaveBeenCalled();
    expect(observer.kill).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(cli.exit).not.toHaveBeenCalled();
    cli.stop();
    expect(lookupChild.kill).toHaveBeenCalledOnce();
  });

  it("cancels pending lookup on parent exit", () => {
    const { compose } = startDocker();
    const before = process.listeners("exit");
    compose.emit("exit", 0, null);
    const onExit = process.listeners("exit").find((listener) => !before.includes(listener));
    expect(onExit).toBeDefined();
    onExit!(0);
    expect(lookupChild.kill).toHaveBeenCalledOnce();
    completeLookup();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.listeners("exit")).toEqual(before);
  });

  it("cleans up when identity lookup throws synchronously", () => {
    const { compose, cli } = startDocker();
    const before = process.listenerCount("exit");
    vi.mocked(execFile).mockImplementationOnce(() => { throw new Error("invalid executable"); });
    compose.emit("exit", 0, null);
    expect(process.listenerCount("exit")).toBe(before);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("invalid executable"));
    expect(cli.exit).not.toHaveBeenCalled();
  });

  it.each([0, 137])("ignores detached client success, then reports actual container exit %i", (code) => {
    const { compose, observer, cli } = startDocker();
    finishStartup(compose);
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledWith("docker", [
      "compose", "-p", "agentmemory-3121", "-f", "/own/compose.yml", "ps", "--all", "--quiet", "iii-engine",
    ], expect.objectContaining({ timeout: 5000, cwd: "/own/invocation" }), expect.any(Function));
    expect(spawn).toHaveBeenLastCalledWith("docker", ["wait", "a".repeat(64)], expect.anything());
    vi.setSystemTime(6000);
    containerExit(observer, code);
    expect(cli.exit).toHaveBeenCalledWith(1);
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(cli.clearPid).not.toHaveBeenCalled();
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed" });
  });

  it("keeps early container failure in startup diagnostics", () => {
    const { compose, observer, cli } = startDocker();
    compose.stderr.emit("data", Buffer.from("Container iii-engine started"));
    finishStartup(compose);
    containerExit(observer, 137);
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed", stderr: "process exited with code 137" });
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(cli.clearPid).not.toHaveBeenCalled();
  });

  it("preserves compose startup failures without starting an observer", () => {
    const { compose, cli } = startDocker();
    compose.stderr.emit("data", Buffer.from("image pull failed"));
    compose.emit("exit", 1, null);
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed", stderr: "image pull failed" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(cli.clearPid).not.toHaveBeenCalled();
  });

  it.each(["exit", "error"])("retains Docker ownership after a slow compose %s failure without declaring container death", (failure) => {
    const { compose, cli } = startDocker();
    vi.setSystemTime(20_000);
    if (failure === "exit") {
      compose.stderr.emit("data", Buffer.from("image pull failed"));
      compose.emit("exit", 1, null);
    } else {
      compose.emit("error", new Error("spawn ENOENT"));
    }
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed" });
    expect(execFile).not.toHaveBeenCalled();
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(cli.clearPid).not.toHaveBeenCalled();
  });

  it("captures a Docker spawn error instead of leaving an unhandled error event", () => {
    const { compose, cli } = startDocker();
    compose.emit("error", new Error("spawn ENOENT"));
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed", stderr: "spawn ENOENT" });
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
  });

  it("honors the engine-death opt-out", () => {
    const { compose, observer, cli } = startDocker();
    cli.env.AGENTMEMORY_EXIT_ON_ENGINE_DEATH = "0";
    finishStartup(compose);
    vi.setSystemTime(6000);
    containerExit(observer, 137);
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(cli.clearPid).not.toHaveBeenCalled();
  });

  it.each(["spawn", "exit", "output"])("reports observer %s errors without declaring the engine dead", (failure) => {
    const { compose, observer, cli } = startDocker();
    finishStartup(compose);
    vi.setSystemTime(6000);
    if (failure === "spawn") observer.emit("error", new Error("spawn EACCES"));
    observer.emit("close", failure === "output" ? 0 : 1, null);
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("supervision unavailable"));
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(cli.failure()).toBeNull();
  });

  it.each(["", "a".repeat(64) + "\n" + "b".repeat(64)])("rejects missing or ambiguous engine identity", (ids) => {
    const { compose, cli } = startDocker();
    compose.emit("exit", 0, null);
    completeLookup(null, ids);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("exactly one iii-engine"));
    expect(cli.exit).not.toHaveBeenCalled();
  });

  it("reports identity lookup errors without stopping any container", () => {
    const { compose, cli } = startDocker();
    const before = process.listenerCount("exit");
    compose.emit("exit", 0, null);
    completeLookup(new Error("Docker unavailable"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Docker unavailable"));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(cli.exit).not.toHaveBeenCalled();
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("reaps only the observer on intentional cleanup and allows the CLI to exit", () => {
    const { compose, observer, cli } = startDocker();
    const before = process.listenerCount("exit");
    finishStartup(compose);
    expect(process.listenerCount("exit")).toBe(before + 1);
    expect(observer.unref).toHaveBeenCalledOnce();
    expect(observer.stdout.unref).toHaveBeenCalledOnce();
    cli.stop();
    expect(process.listenerCount("exit")).toBe(before);
    expect(observer.kill).toHaveBeenCalledOnce();
    expect(compose.kill).not.toHaveBeenCalled();
    observer.emit("close", null, "SIGTERM");
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reaps the observer when its parent exits", () => {
    const { compose, observer, cli } = startDocker();
    const before = process.listeners("exit");
    finishStartup(compose);
    const onExit = process.listeners("exit").find((listener) => !before.includes(listener));
    expect(onExit).toBeDefined();
    onExit!(0);
    expect(observer.kill).toHaveBeenCalledOnce();
    observer.emit("close", null, "SIGTERM");
    expect(cli.exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("native engine launch and stderr capture", () => {
  it.each([false, true])("preserves native cwd, bounded stderr and fatal cleanup with log forwarding %s", logEnabled => {
    const engine = child();
    vi.mocked(spawn).mockReturnValueOnce(engine as never);
    const cli = cliSpawn(logEnabled);
    cli.start("iii", ["--config", "/native/runtime.yaml"], "iii-engine", "/native/cwd");
    expect(spawn).toHaveBeenCalledWith("iii", ["--config", "/native/runtime.yaml"], expect.objectContaining({
      cwd: "/native/cwd",
      stdio: ["ignore", logEnabled ? "pipe" : "ignore", "pipe"],
    }));
    expect(cli.writePid).toHaveBeenCalledWith(engine.pid);
    expect(cli.attachLog).toHaveBeenCalledTimes(logEnabled ? 2 : 0);
    engine.stderr.emit("data", Buffer.alloc(20 * 1024, "x"));
    engine.stderr.emit("data", Buffer.from("discarded"));
    expect(cli.stderr()).toBe("x".repeat(16 * 1024));
    vi.setSystemTime(6000);
    engine.emit("exit", 1, null);
    expect(cli.failure()).toMatchObject({ kind: "engine-crashed", stderr: "x".repeat(16 * 1024) });
    expect(cli.clearPid).toHaveBeenCalledOnce();
    expect(cli.clearState).toHaveBeenCalledOnce();
    expect(cli.exit).toHaveBeenCalledWith(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("retains each launch's stderr while exposing the latest capture for startup timeouts", () => {
    const first = child();
    const second = child();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const cli = cliSpawn();
    cli.start("iii", [], "iii-engine", "/first");
    first.stderr.emit("data", Buffer.from("first startup error"));
    cli.start("iii", [], "iii-engine", "/second");
    second.stderr.emit("data", Buffer.from("second startup output"));
    first.emit("exit", 1, null);
    expect(cli.failure()).toMatchObject({ stderr: "first startup error" });
    expect(cli.stderr()).toBe("second startup output");
  });
});

describe("resumed Docker engine supervision", () => {
  it.each([0, 137])("watches the verified ID without compose access and handles later exit %i", code => {
    const observer = child();
    vi.mocked(spawn).mockReturnValueOnce(observer as never);
    const cli = cliSpawn();
    cleanups.push(cli.stop);
    cli.watch("docker", { containerId: "b".repeat(64) });
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith("docker", ["wait", "b".repeat(64)], expect.anything());
    vi.setSystemTime(6000);
    containerExit(observer, code);
    expect(cli.exit).toHaveBeenCalledWith(1);
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(cli.clearPid).not.toHaveBeenCalled();
  });

  it("honors the opt-out for a resumed engine", () => {
    const observer = child();
    vi.mocked(spawn).mockReturnValueOnce(observer as never);
    const cli = cliSpawn();
    cleanups.push(cli.stop);
    cli.env.AGENTMEMORY_EXIT_ON_ENGINE_DEATH = "0";
    cli.watch("docker", { containerId: "b".repeat(64) });
    vi.setSystemTime(6000);
    containerExit(observer, 137);
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).not.toHaveBeenCalled();
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed" });
  });

  it("replaces an old observer without stopping either container or reporting cancellation as death", () => {
    const first = child();
    const second = child();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const cli = cliSpawn();
    cleanups.push(cli.stop);
    cli.watch("docker", { containerId: "a".repeat(64) });
    cli.watch("docker", { containerId: "b".repeat(64) });
    expect(first.kill).toHaveBeenCalledOnce();
    vi.setSystemTime(6000);
    first.emit("close", null, "SIGTERM");
    expect(cli.exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    cli.stop();
    expect(second.kill).toHaveBeenCalledOnce();
    second.emit("close", null, "SIGTERM");
    expect(cli.exit).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(vi.mocked(spawn).mock.calls.every(([, args]) => args?.[0] === "wait")).toBe(true);
  });

  it("rejects invalid direct IDs without starting a Docker command", () => {
    const cli = cliSpawn();
    const before = process.listenerCount("exit");
    cleanups.push(cli.stop);
    cli.watch("docker", { containerId: "not-a-container-id" });
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(cli.exit).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("exactly one iii-engine"));
    expect(process.listenerCount("exit")).toBe(before);
  });
});
