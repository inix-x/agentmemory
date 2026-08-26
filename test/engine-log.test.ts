import { describe, expect, it } from "vitest";
import {
  ENGINE_LOG_MAX_BYTES_PER_SECOND,
  ENGINE_LOG_MAX_TOTAL_BYTES,
  createEngineLogForwarder,
} from "../src/cli/engine-log.js";

function harness(overrides: Record<string, unknown> = {}) {
  const lines: string[] = [];
  let clock = 0;
  const forwarder = createEngineLogForwarder({
    prefix: "[engine]",
    write: (line) => lines.push(line),
    now: () => clock,
    ...overrides,
  });
  return {
    lines,
    forwarder,
    advance(ms: number) {
      clock += ms;
    },
    push(text: string) {
      forwarder.push(Buffer.from(text, "utf8"));
    },
  };
}

describe("engine log forwarder", () => {
  it("prefixes each complete line and holds partial lines back", () => {
    const h = harness();

    h.push("registered worker\nWorker unregis");
    expect(h.lines).toEqual(["[engine] registered worker"]);

    h.push("tered\n");
    expect(h.lines).toEqual([
      "[engine] registered worker",
      "[engine] Worker unregistered",
    ]);
  });

  it("strips carriage returns and decodes utf8 split across chunks", () => {
    const h = harness();
    const snowman = Buffer.from("☃", "utf8");

    h.push("crlf line\r\n");
    h.forwarder.push(snowman.subarray(0, 1));
    h.forwarder.push(snowman.subarray(1));
    h.push("\n");

    expect(h.lines).toEqual(["[engine] crlf line", "[engine] ☃"]);
  });

  it("flushes a trailing partial line when the stream ends", () => {
    const h = harness();

    h.push("panic: engine died");
    expect(h.lines).toEqual([]);

    h.forwarder.flush();
    expect(h.lines).toEqual(["[engine] panic: engine died"]);
  });

  it("stops permanently once the lifetime ceiling is reached", () => {
    const h = harness({ maxTotalBytes: 64, maxBytesPerSecond: 1024 * 1024 });

    for (let i = 0; i < 200; i += 1) h.push(`line ${i}\n`);

    const terminal = h.lines.filter((l) => l.includes("ceiling reached"));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toBe(
      "[engine] log forwarding stopped: 64 byte ceiling reached",
    );
    expect(h.lines[h.lines.length - 1]).toBe(terminal[0]);

    const forwarded = h.lines.filter((l) => !l.includes("ceiling reached"));
    const forwardedBytes = forwarded.reduce(
      (sum, l) => sum + Buffer.byteLength(l) + 1,
      0,
    );
    expect(forwardedBytes).toBeLessThanOrEqual(64);

    const before = h.lines.length;
    h.push("still chatty\n");
    h.advance(10_000);
    h.push("still chatty\n");
    h.forwarder.flush();
    expect(h.lines).toHaveLength(before);
  });

  it("stays silent for the rest of a single chunk that trips the ceiling", () => {
    const h = harness({ maxTotalBytes: 64, maxBytesPerSecond: 1024 * 1024 });

    h.push(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");

    expect(h.lines.filter((l) => l.includes("ceiling reached"))).toHaveLength(1);
    expect(h.lines[h.lines.length - 1]).toBe(
      "[engine] log forwarding stopped: 64 byte ceiling reached",
    );
  });

  it("drops over the rate cap and reports the drop once per window", () => {
    const h = harness({ maxBytesPerSecond: 64, maxTotalBytes: 1024 * 1024 });
    const a = "a".repeat(30);

    h.push(`${a}\n`);
    h.push(`${"b".repeat(30)}\n`);
    h.push(`${"c".repeat(30)}\n`);
    expect(h.lines).toEqual([`[engine] ${a}`]);

    h.advance(1000);
    h.push(`${"d".repeat(30)}\n`);
    expect(h.lines).toEqual([
      `[engine] ${a}`,
      "[engine] dropped 80 bytes (rate cap 64 bytes/s)",
    ]);
  });

  it("never suppresses silently, even with the window budget exhausted", () => {
    const h = harness({ maxBytesPerSecond: 64, maxTotalBytes: 1024 * 1024 });

    for (let i = 0; i < 20; i += 1) h.push(`${"a".repeat(30)}\n`);
    h.forwarder.flush();

    expect(h.lines).toEqual([
      `[engine] ${"a".repeat(30)}`,
      "[engine] dropped 760 bytes (rate cap 64 bytes/s)",
    ]);
  });

  it("charges its exempt notices against the lifetime ceiling", () => {
    const h = harness({ maxBytesPerSecond: 8, maxTotalBytes: 200 });

    for (let round = 0; round < 40; round += 1) {
      h.push(`${"a".repeat(30)}\n`);
      h.advance(1000);
    }

    const forwardedBytes = h.lines
      .filter((l) => !l.includes("ceiling reached"))
      .reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0);
    expect(forwardedBytes).toBeLessThanOrEqual(200);
    expect(h.lines.filter((l) => l.includes("ceiling reached"))).toHaveLength(1);
  });

  it("force-flushes a newline-free stream instead of buffering it forever", () => {
    const h = harness({ maxLineBytes: 16 });

    h.push("0123456789abcdefghij");

    expect(h.lines).toEqual(["[engine] 0123456789abcdefghij"]);
  });

  it("ships ceilings that bound a firehose without operator action", () => {
    expect(ENGINE_LOG_MAX_TOTAL_BYTES).toBe(32 * 1024 * 1024);
    expect(ENGINE_LOG_MAX_BYTES_PER_SECOND).toBe(64 * 1024);
  });
});
