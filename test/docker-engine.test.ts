import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { execFile, spawn } from "node:child_process";
import { transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchDockerEngine } from "../src/cli/docker-engine.js";

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
const functionStart = source.indexOf("function spawnEngineBackground(");
const functionEnd = source.indexOf("const ENGINE_STARTUP_GRACE_MS", functionStart);
const graceEnd = source.indexOf(";", functionEnd) + 1;
const compiledSpawn = transpileModule(source.slice(functionStart, graceEnd), {}).outputText;

// Run the CLI's actual spawn function without executing its command dispatcher.
function cliSpawn() {
  const exit = vi.fn();
  const clearState = vi.fn();
  const env: Record<string, string> = {};
  const factory = new Function("spawn", "watchDockerEngine", "process", "clearEngineState", `
    const vlog = () => {};
    const writeEnginePidfile = () => {};
    const clearEnginePidfile = () => {};
    const ENGINE_LOG_ENABLED = false;
    const IS_VERBOSE = false;
    let startupFailure = null;
    let stopDockerEngineWatch;
    ${compiledSpawn}
    return {
      start: spawnEngineBackground,
      failure: () => startupFailure,
      stop: () => stopDockerEngineWatch?.(),
    };
  `);
  return { ...factory(spawn, watchDockerEngine, { env, exit }, clearState), exit, env, clearState };
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
  cli.start("docker", ["compose", "-f", "/own/compose.yml", "up", "-d"], "iii-engine via Docker", "/own/compose.yml");
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
      "compose", "-f", "/own/compose.yml", "ps", "--all", "--quiet", "iii-engine",
    ], expect.objectContaining({ timeout: 5000 }), expect.any(Function));
    expect(spawn).toHaveBeenLastCalledWith("docker", ["wait", "a".repeat(64)], expect.anything());
    vi.setSystemTime(6000);
    containerExit(observer, code);
    expect(cli.exit).toHaveBeenCalledWith(1);
    expect(cli.clearState).toHaveBeenCalledOnce();
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed" });
  });

  it("keeps early container failure in startup diagnostics", () => {
    const { compose, observer, cli } = startDocker();
    compose.stderr.emit("data", Buffer.from("Container iii-engine started"));
    finishStartup(compose);
    containerExit(observer, 137);
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed", stderr: "process exited with code 137" });
    expect(cli.exit).not.toHaveBeenCalled();
  });

  it("preserves compose startup failures without starting an observer", () => {
    const { compose, cli } = startDocker();
    compose.stderr.emit("data", Buffer.from("image pull failed"));
    compose.emit("exit", 1, null);
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed", stderr: "image pull failed" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(cli.exit).not.toHaveBeenCalled();
  });

  it("captures a Docker spawn error instead of leaving an unhandled error event", () => {
    const { compose, cli } = startDocker();
    compose.emit("error", new Error("spawn ENOENT"));
    expect(cli.failure()).toMatchObject({ kind: "docker-crashed", stderr: "spawn ENOENT" });
    expect(cli.exit).not.toHaveBeenCalled();
  });

  it("honors the engine-death opt-out", () => {
    const { compose, observer, cli } = startDocker();
    cli.env.AGENTMEMORY_EXIT_ON_ENGINE_DEATH = "0";
    finishStartup(compose);
    vi.setSystemTime(6000);
    containerExit(observer, 137);
    expect(cli.exit).not.toHaveBeenCalled();
    expect(cli.clearState).toHaveBeenCalledOnce();
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
