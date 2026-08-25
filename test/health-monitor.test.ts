import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HealthSnapshot } from "../src/types.js";
import { bumpEscalation, type EscalationState } from "../src/health/monitor.js";

function snap(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    connectionState: "connected",
    workers: [],
    memory: { heapUsed: 0, heapTotal: 1, rss: 0, external: 0 },
    cpu: { userMicros: 0, systemMicros: 0, percent: 0 },
    eventLoopLagMs: 0,
    uptimeSeconds: 600,
    kvConnectivity: { status: "ok", latencyMs: 1 },
    status: "healthy",
    alerts: [],
    ...over,
  };
}

const stalled = () => snap({ kvConnectivity: { status: "error", error: "kv_probe_failed" } });

function fresh(): EscalationState {
  return { consecutiveStalls: 0, armed: false, escalated: false };
}

/** Arm the state the way a healthy first collection would. */
function armed(): EscalationState {
  const s = fresh();
  bumpEscalation(snap(), s, 3);
  return s;
}

describe("bumpEscalation arming", () => {
  // Mirrors the shell watchdog's "wait for a first success" rule. Without it a
  // store that is already stalled at boot escalates on the first minute of every
  // container life, spending the platform's restart budget in minutes.
  it("never escalates when the store is stalled from the very first check", () => {
    const state = fresh();
    for (let i = 0; i < 50; i++) {
      expect(bumpEscalation(stalled(), state, 3)).toBe(false);
    }
    expect(state.armed).toBe(false);
    expect(state.consecutiveStalls).toBe(0);
  });

  it("arms on the first healthy probe", () => {
    const state = fresh();
    bumpEscalation(snap(), state, 3);
    expect(state.armed).toBe(true);
  });
});

describe("bumpEscalation gating", () => {
  it("escalates on the Nth consecutive stall, not before", () => {
    const state = armed();
    expect(bumpEscalation(stalled(), state, 3)).toBe(false);
    expect(bumpEscalation(stalled(), state, 3)).toBe(false);
    expect(bumpEscalation(stalled(), state, 3)).toBe(true);
  });

  it("resets the counter on a healthy probe", () => {
    const state = armed();
    bumpEscalation(stalled(), state, 3);
    bumpEscalation(stalled(), state, 3);
    bumpEscalation(snap(), state, 3);
    expect(state.consecutiveStalls).toBe(0);
    expect(bumpEscalation(stalled(), state, 3)).toBe(false);
  });

  it("escalates at most once per process", () => {
    const state = armed();
    let fired = 0;
    for (let i = 0; i < 20; i++) {
      if (bumpEscalation(stalled(), state, 1)) fired++;
    }
    expect(fired).toBe(1);
  });

  // The gate is the KV probe, not snapshot.status. evaluateHealth raises
  // `critical` from five independent conditions, so gating on the aggregate
  // would let a CPU spike during a consolidation pass kill a healthy process.
  it.each([
    ["cpu", { cpu: { userMicros: 0, systemMicros: 0, percent: 99 } }],
    ["event loop lag", { eventLoopLagMs: 5000 }],
    ["connection", { connectionState: "disconnected" }],
    ["memory", { memory: { heapUsed: 99, heapTotal: 100, rss: 99, external: 0 } }],
  ])("never escalates on a %s critical while the KV probe is healthy", (_label, over) => {
    const state = armed();
    for (let i = 0; i < 50; i++) {
      expect(
        bumpEscalation(snap({ ...over, status: "critical" } as Partial<HealthSnapshot>), state, 3),
      ).toBe(false);
    }
    expect(state.consecutiveStalls).toBe(0);
  });

  it("treats an absent kvConnectivity as no signal, not as a stall", () => {
    const state = armed();
    const s = snap();
    delete s.kvConnectivity;
    for (let i = 0; i < 50; i++) {
      expect(bumpEscalation(s, state, 3)).toBe(false);
    }
    expect(state.consecutiveStalls).toBe(0);
  });
});

// KTD7. The escalation decision must precede the snapshot persist. `kv.set`
// routes through `sdk.trigger`, whose invocationTimeoutMs is 180000
// (src/index.ts), so a stalled store parks the persist for three minutes. A
// counter placed behind it would never advance during the exact failure it
// exists to catch.
//
// Asserted on source order because no test constructs registerHealthMonitor, so
// the call site is otherwise executed by nothing. Verified discriminating: this
// passes on the real tree and fails on a tree with the two lines swapped.
// Matches the precedent in test/cli-second-instance-guard.test.ts.
describe("collectHealth statement order", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/health/monitor.ts", import.meta.url)),
    "utf8",
  );

  it("decides escalation before the un-raced snapshot persist", () => {
    const decide = src.indexOf("bumpEscalation(snapshot, escalationState");
    const persist = src.indexOf('kv.set(KV.health, "latest"');
    expect(decide).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(persist);
  });

  // The workers probe sits upstream of both. Unraced it inherits the engine's
  // 180s invocation timeout and delays detection by tens of minutes.
  it("races the workers probe so it cannot park the collection", () => {
    const workers = src.indexOf('function_id: "engine::workers::list"');
    expect(workers).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, workers - 400), workers);
    expect(before).toContain("Promise.race");
  });
});
