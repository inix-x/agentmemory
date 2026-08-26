import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_LOG_MAX_BYTES_PER_SECOND } from "../src/cli/engine-log.js";

describe("engine spawn stdio and death detection", () => {
  const source = readFileSync("src/cli.ts", "utf8");
  const spawnStart = source.indexOf("function spawnEngineBackground");
  const spawnEnd = source.indexOf("const ENGINE_STARTUP_GRACE_MS", spawnStart);
  const spawnBody = source.slice(spawnStart, spawnEnd);

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
    expect(spawnBody).toContain("const stderrChunks: Buffer[] = []");
    expect(spawnBody).toContain(
      'child.stderr?.on("data", (chunk: Buffer) => {\n    if (stderrBytes >= MAX_STDERR_CAPTURE) return;',
    );
    expect(spawnBody).toContain("const engineRanFor = Date.now() - spawnedAt");
    expect(spawnBody).toContain("if (engineRanFor > ENGINE_STARTUP_GRACE_MS)");
    expect(spawnBody).toContain(
      'if (process.env["AGENTMEMORY_EXIT_ON_ENGINE_DEATH"] !== "0") {\n          process.exit(1);',
    );

    // The capture listener and the exit handler must sit outside the gate.
    const gateStart = spawnBody.indexOf("if (ENGINE_LOG_ENABLED) {");
    const gateEnd = spawnBody.indexOf("}", spawnBody.indexOf("[engine:err]"));
    const gateBlock = spawnBody.slice(gateStart, gateEnd);
    expect(gateBlock).not.toContain("stderrChunks");
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
    expect(spawnBody).toContain(
      'const stderr = Buffer.concat(stderrChunks).toString("utf-8")',
    );
    expect(spawnBody).toContain(
      "if (stderr.trim()) console.error(`[agentmemory] engine stderr:\\n${stderr}`)",
    );
  });
});
