import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_LOG_MAX_BYTES_PER_SECOND } from "../src/cli/engine-log.js";

describe("engine spawn stdio and death detection", () => {
  const source = readFileSync("src/cli.ts", "utf8");
  const spawnStart = source.indexOf("function spawnEngineBackground");
  const spawnEnd = source.indexOf("const ENGINE_STARTUP_GRACE_MS", spawnStart);
  const spawnBody = source.slice(spawnStart, spawnEnd);
  const exitBody = source.slice(source.indexOf("function createEngineExitHandler"), spawnStart);

  it("forwards engine stdout only behind the opt-in gate", () => {
    expect(spawnBody).toContain(
      'stdio: ["ignore", ENGINE_LOG_ENABLED ? "pipe" : "ignore", "pipe"]',
    );
    expect(spawnBody).not.toContain('stdio: ["ignore", "ignore", "pipe"]');
    expect(spawnBody).toContain(
      'if (ENGINE_LOG_ENABLED) {\n    attachEngineLog(child.stdout, "[engine]");\n    attachEngineLog(child.stderr, "[engine:err]");\n  }',
    );

    expect(source).toContain(
      'const ENGINE_LOG_ENABLED =\n  process.env["AGENTMEMORY_ENGINE_LOG"] === "1" ||\n  process.env["AGENTMEMORY_ENGINE_LOG"] === "true"',
    );
    expect(source).toContain('stream.on("end", () => forwarder.flush())');
  });

  // Engine-death detection is the only thing that turns a dead engine into a
  // container restart. Log forwarding shares the same spawn call and the same
  // stderr stream, so these assertions exist to fail if forwarding is ever
  // allowed to gate, replace, or reorder any part of it.
  it("keeps engine-death detection ungated by the log forwarder", () => {
    expect(spawnBody).toContain("const spawnedAt = Date.now()");
    expect(spawnBody).toContain("stderrCapture = activeStartupStderr = createStartupStderrCapture()");
    expect(spawnBody).toContain(
      'child.stderr?.on("data", (chunk: Buffer) => {\n    stderrCapture.append(chunk);',
    );
    expect(exitBody).toContain("const engineRanFor = Date.now() - spawnedAt");
    expect(exitBody).toContain("engineRanFor > ENGINE_STARTUP_GRACE_MS");
    expect(exitBody).toContain(
      'if (process.env["AGENTMEMORY_EXIT_ON_ENGINE_DEATH"] !== "0") {\n          process.exit(1);',
    );

    // The capture listener and the exit handler must sit outside the gate.
    const gateStart = spawnBody.indexOf("if (ENGINE_LOG_ENABLED) {");
    const gateEnd = spawnBody.indexOf("}", spawnBody.indexOf("[engine:err]"));
    const gateBlock = spawnBody.slice(gateStart, gateEnd);
    expect(gateBlock).not.toContain("stderrCapture.append");
    expect(gateBlock).not.toContain("process.exit(1)");
    expect(spawnBody.indexOf('child.on("exit"')).toBeGreaterThan(gateEnd);
  });

  // The forwarder and the death report share process.stderr, and process.exit(1)
  // discards pending async writes on a pipe, so the rate cap is what bounds how
  // much forwarder output can ever sit ahead of the death report inside one
  // second. Measured non-displacing at 64 KiB against a no-forwarder control;
  // raising this cap voids that measurement, so it is pinned here rather than
  // left to the structural assertions above, which would all still pass.
  it("keeps the rate cap low enough not to crowd out the death report", () => {
    expect(ENGINE_LOG_MAX_BYTES_PER_SECOND).toBeLessThanOrEqual(64 * 1024);
  });

  it("still captures the dying engine's stderr for the death report", () => {
    expect(spawnBody).toContain("() => stderrCapture.text()");
    expect(exitBody).toContain("const stderr = readStderr()");
    expect(exitBody).toContain(
      "if (stderr.trim()) console.error(`[agentmemory] engine stderr:\\n${stderr}`)",
    );
  });
});

describe("fresh native engine startup", () => {
  const source = readFileSync("src/cli.ts", "utf8");

  it("routes existing and newly installed engines through one runtime config", () => {
    const prepareStart = source.indexOf("function prepareEngineLaunch");
    const prepareEnd = source.indexOf("function startIiiBin", prepareStart);
    const prepareBody = source.slice(prepareStart, prepareEnd);
    expect(prepareBody).toContain("dataDir: dataDirResolution.dataDir");
    expect(prepareBody).toContain("restPort: getRestPort()");
    expect(prepareBody).toContain("streamPort: getStreamPort()");
    expect(prepareBody).toContain("viewerPort: getConfiguredViewerPort()");
    expect(prepareBody).toContain("enginePort: getEnginePort()");

    const engineStart = source.indexOf("async function startEngine");
    const engineEnd = source.indexOf("async function waitForEngine", engineStart);
    const engineBody = source.slice(engineStart, engineEnd);
    expect(engineBody).not.toContain("writeRuntimeIiiConfig");
    expect(engineBody.match(/startIiiBin\(iiiBin, configPath\)/g)).toHaveLength(2);
  });

  it("reports buffered engine stderr when a verbose startup times out", () => {
    const spawnStart = source.indexOf("function spawnEngineBackground");
    const spawnEnd = source.indexOf("function prepareEngineLaunch", spawnStart);
    const spawnBody = source.slice(spawnStart, spawnEnd);
    expect(spawnBody).toContain(
      "activeStartupStderr = createStartupStderrCapture()",
    );
    expect(spawnBody).toContain("stderrCapture.append(chunk)");

    const timeoutStart = source.indexOf("const ready = await waitForEngine(15000)");
    const timeoutEnd = source.indexOf('s.stop(c.ok("iii-engine is ready"))', timeoutStart);
    expect(source.slice(timeoutStart, timeoutEnd)).toContain(
      "printCapturedStartupStderr()",
    );

    const demoTimeoutStart = source.indexOf("await waitForEngine(15000)", timeoutEnd);
    const demoTimeoutEnd = source.indexOf("await import(\"./index.js\")", demoTimeoutStart);
    expect(source.slice(demoTimeoutStart, demoTimeoutEnd)).toContain(
      "printCapturedStartupStderr()",
    );
  });

  it("exports the complete derived port set for Docker and native launchers", () => {
    expect(source).toContain(
      'process.env["III_STREAM_PORT"] ??=\n    process.env["III_STREAMS_PORT"] ?? String(restPort + 1)',
    );
    expect(source).toContain(
      'process.env["III_VIEWER_PORT"] ??= String(restPort + 2)',
    );
    expect(source).toContain(
      'process.env["III_ENGINE_PORT"] ??= String(restPort + 46023)',
    );
    expect(source).toContain("new URL(configuredEngineUrl).port");
    expect(source).toContain(
      'process.env["III_ENGINE_PORT"] = parsedEnginePort',
    );
    expect(source).toContain(
      'process.env["AGENTMEMORY_METRICS_PORT"] ??= String(restPort + 6353)',
    );
    expect(source).toContain(
      'process.env["AGENTMEMORY_DATA_DIR"] = dataDirResolution.dataDir',
    );
  });

  it("checks every Unix engine installer prerequisite before downloading", () => {
    const installerStart = source.indexOf("async function runIiiInstaller");
    const installerEnd = source.indexOf("type StartupFailure", installerStart);
    const installerBody = source.slice(installerStart, installerEnd);
    expect(installerBody).toContain('whichBinary("sh")');
    expect(installerBody).toContain('whichBinary("curl")');
    expect(installerBody).toContain('whichBinary("tar")');
  });

  it("lets the CLI own one bundled worker and reuses a live worker", () => {
    const prepareStart = source.indexOf("function prepareEngineLaunch");
    const prepareEnd = source.indexOf("function startIiiBin", prepareStart);
    const prepareBody = source.slice(prepareStart, prepareEnd);
    expect(prepareBody).toContain(
      "rewriteBundledConfig(",
    );
    expect(prepareBody).toContain(": renderEngineConfig(rawConfig, options)");

    const workerStart = source.indexOf("async function startWorkerForEngineState");
    const workerEnd = source.indexOf("async function startEngine", workerStart);
    const workerBody = source.slice(workerStart, workerEnd);
    expect(workerBody).toContain("readWorkerPidfile()");
    expect(workerBody).toContain("pidAlive(workerPid)");
    expect(workerBody).toContain("waitForConfiguredWorker");
    expect(workerBody).toContain('await import("./index.js")');

    expect(source.match(/await startWorkerForEngineState\(\)/g)).toHaveLength(4);
    expect(source).toContain("agentmemory worker did not become ready within 15s");
  });

  it("stores lifecycle metadata per resolved instance and scopes Docker", () => {
    expect(source).toContain('runtimeMetadataPath("iii.pid")');
    expect(source).toContain('runtimeMetadataPath("engine-state.json")');
    expect(source).toContain('runtimeMetadataPath("worker.pid")');
    expect(source).toContain('process.env["AGENTMEMORY_RUNTIME_DIR"] = selectedInstance > 0');
    expect(source).toContain("dockerProjectName(getRestPort())");
    expect(source).toContain("dockerComposeArgs(");
  });

  it("keeps AGENTMEMORY_URL client-only and lets local port flags win", () => {
    expect(source).toContain('const URL_CLIENT_COMMANDS = new Set(["status", "doctor", "mcp"])');
    expect(source).toContain("hasExplicitLocalPortOverride");
    expect(source).toContain("shouldUseAgentmemoryUrl()");
    expect(source).toContain('process.env["III_REST_PORT"] = String(base)');
  });

  it("recovers the host worker for a validated Docker engine", () => {
    expect(source).toContain("function inspectOwnedDockerEngine");
    expect(source).toMatch(/"ps",\s*"-q",\s*"--all",\s*"iii-engine"/);
    expect(source).toContain('"com.docker.compose.service"');
    expect(source).toContain('record.HostConfig?.PortBindings');
    expect(source).toContain('mount.Destination === "/data"');
    expect(source).toContain('["start", inspection.containerId]');
    expect(source).toContain('["stop", "--time", "10", inspection.containerId]');

    const mainStart = source.indexOf("async function main()");
    const mainEnd = source.indexOf("async function apiFetch", mainStart);
    const mainBody = source.slice(mainStart, mainEnd);
    expect(mainBody).toContain("reconcilePersistedDockerEngine()");
    expect(mainBody.indexOf("reconcilePersistedDockerEngine()"))
      .toBeLessThan(mainBody.indexOf("if (await isEngineRunning())"));
  });

  it("keeps canonical compatibility and rejects Docker ownership on another port", () => {
    expect(source).toContain('function cliArgValue(name: string)');
    expect(source).toContain('arg.startsWith(`${name}=`)');
    expect(source).toContain("async function assertRuntimePortOwnership");
    expect(source).toContain("restPort: getRestPort()");
    expect(source).toContain('inspection.status === "running" || inspection.status === "stopped"');
    expect(source).not.toContain("migrateLegacyRuntimeMetadata");
    expect(source).not.toContain("clearLegacyRuntimeMetadata");
  });

  it("preserves Docker ownership when compose startup fails", () => {
    const spawnStart = source.indexOf("function createEngineExitHandler");
    const spawnEnd = source.indexOf("function prepareEngineLaunch", spawnStart);
    const spawnBody = source.slice(spawnStart, spawnEnd);
    expect(spawnBody).toContain("if (!isDocker)");
    expect(spawnBody).toContain("clearEngineState()");
    expect(spawnBody).not.toContain("if (!isDocker) clearEnginePidfile();\n      clearEngineState();");
  });

  it.each([
    ["async function startEngine", "const configPath = findIiiConfig()"],
    ["async function reconcilePersistedDockerEngine", "function installInstructions"],
  ])("arms supervision for verified resumed containers in %s", (start, end) => {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin);
    expect(begin).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(begin);
    const body = source.slice(begin, finish);
    expect(body).toContain("inspectOwnedDockerEngine(");
    expect(body).toContain('["start", inspection.containerId]');
    expect(body).toContain("startDockerEngineWatch(dockerBin, { containerId: inspection.containerId })");
    expect(body.indexOf("startDockerEngineWatch(")).toBeGreaterThan(body.indexOf('["start", inspection.containerId]'));
  });

  it("cancels local supervision before intentionally stopping an owned container", () => {
    const start = source.indexOf("async function stopDockerEngine(");
    const end = source.indexOf("async function runStop(", start);
    const body = source.slice(start, end);
    expect(body.indexOf("stopDockerEngineWatch?.()")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("stopDockerEngineWatch?.()")).toBeLessThan(body.indexOf('["stop", "--time", "10", inspection.containerId]'));
  });
});
