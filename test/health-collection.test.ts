import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISdk } from "iii-sdk";
import type { StateKV } from "../src/state/kv.js";
import type { HealthSnapshot } from "../src/types.js";
import { KV } from "../src/state/schema.js";
vi.mock("node:v8", () => ({ getHeapStatistics: vi.fn(() => ({ heap_size_limit: 100 })) }));
vi.mock("../src/health/memory.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/health/memory.js")>(), collectCgroupMemory: vi.fn(async () => ({ status: "unsupported", levels: [] })) }));
import { collectCgroupMemory } from "../src/health/memory.js";
import { registerHealthMonitor } from "../src/health/monitor.js";
import { registerApiTriggers } from "../src/triggers/api.js";

let used = 96;
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  used = 96;
  vi.spyOn(process, "memoryUsage").mockImplementation(() => ({ heapUsed: used, heapTotal: 100, rss: 200, external: 0, arrayBuffers: 0 }));
  vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 0, system: 0 });
  vi.mocked(collectCgroupMemory).mockResolvedValue({ status: "unsupported", levels: [] });
});
afterEach(() => { stop?.(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function setup() {
  const stored = new Map<string, unknown>();
  const history: HealthSnapshot[] = [];
  const functions = new Map<string, (payload: unknown) => Promise<any>>();
  const sdk = { on: vi.fn(), trigger: vi.fn(async () => ({ workers: [] })), registerFunction: (id: string, fn: (payload: unknown) => Promise<any>) => functions.set(id, fn), registerTrigger: vi.fn() };
  const kv = { set: vi.fn(async (_scope: string, key: string, value: unknown) => { stored.set(key, value); if (key === "latest") history.push(value as HealthSnapshot); }), get: vi.fn(async (_scope: string, key: string) => stored.get(key)), list: vi.fn(async () => []) };
  registerApiTriggers(sdk as unknown as ISdk, kv as unknown as StateKV);
  stop = registerHealthMonitor(sdk as unknown as ISdk, kv as unknown as StateKV).stop;
  return { sdk, kv, history, health: () => functions.get("api::health")!({}), latest: () => stored.get("latest") as HealthSnapshot };
}
async function flush() { await vi.advanceTimersByTimeAsync(1); }
async function tick() { await vi.advanceTimersByTimeAsync(30_000); }

describe("periodic memory hold and persisted API health", () => {
  it("requires two observations to enter and clear; polls cannot advance the hold", async () => {
    const app = setup(); await flush();
    expect(app.latest().status).toBe("degraded");
    expect(app.latest().memory.evaluations?.[0].transition).toBe("entering");
    for (let i = 0; i < 3; i++) expect((await app.health()).status_code).toBe(200);
    await tick(); expect((await app.health()).status_code).toBe(503);
    used = 20; await tick();
    expect(app.latest().memory.evaluations?.[0].transition).toBe("recovering");
    expect((await app.health()).status_code).toBe(503);
    await tick(); expect((await app.health()).status_code).toBe(200);
  });

  it("interrupts spikes, missing entry samples and recovery samples", async () => {
    const app = setup(); await flush();
    used = 20; await tick(); used = 96; await tick(); expect(app.latest().status).toBe("degraded");
    used = NaN; await tick(); used = 96; await tick(); expect(app.latest().status).toBe("degraded");
    await tick(); expect(app.latest().status).toBe("critical");
    used = 20; await tick(); used = NaN; await tick();
    expect(app.latest().memory.evaluations?.[0]).toMatchObject({ severity: "critical", available: false, transition: "unavailable" });
    used = 20; await tick(); expect(app.latest().status).toBe("critical");
    await tick(); expect(app.latest().status).toBe("healthy");
  });

  it("retains a vanished critical cgroup source and resets on monitor restart", async () => {
    used = 1;
    vi.mocked(collectCgroupMemory).mockResolvedValue({ status: "available", levels: [{ path: "/parent", current: 96, max: 100 }] });
    const app = setup(); await flush(); await tick(); expect(app.latest().status).toBe("critical");
    vi.mocked(collectCgroupMemory).mockResolvedValue({ status: "unavailable", levels: [] });
    await tick(); expect(app.latest().memory.evaluations).toContainEqual(expect.objectContaining({ path: "/parent", severity: "critical", transition: "unavailable" }));
    stop?.(); stop = registerHealthMonitor(app.sdk as unknown as ISdk, app.kv as unknown as StateKV).stop;
    await flush(); expect(app.latest().status).toBe("healthy");
  });

  it("reads configuration once and keeps KV failures immediate", async () => {
    vi.stubEnv("AGENTMEMORY_HEALTH_MEM_HOLD_SAMPLES", "3");
    const app = setup(); await flush();
    vi.stubEnv("AGENTMEMORY_HEALTH_MEM_HOLD_SAMPLES", "1");
    await tick(); expect(app.latest().status).toBe("degraded");
    app.kv.get.mockRejectedValue(new Error("KV unavailable"));
    used = 20; await tick();
    expect(app.latest().status).toBe("critical");
    expect(app.latest().alerts).toContain("kv_probe_failed");
  });

  it("discards out-of-order probe completions without double-counting entry", async () => {
    let release: (value: { status: "unsupported"; levels: [] }) => void;
    vi.mocked(collectCgroupMemory).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const app = setup(); await flush(); await tick();
    expect(app.latest().status).toBe("degraded");
    release!({ status: "unsupported", levels: [] }); await flush();
    expect(app.history).toHaveLength(1);
    await tick(); expect(app.latest().status).toBe("critical");
  });

  it("escalates ten failed probes despite a stalled persist and times out workers", async () => {
    vi.stubEnv("AGENTMEMORY_HEALTH_ESCALATE", "true");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = setup(); await flush();
    const original = app.kv.set.getMockImplementation()!;
    app.kv.set.mockImplementation((scope, key, value) => key === "latest" ? new Promise(() => {}) : original(scope, key, value));
    app.kv.get.mockRejectedValue(new Error("store unavailable"));
    app.sdk.trigger.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 9; i++) await tick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).not.toHaveBeenCalled();
    await tick();
    expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGTERM");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("KV unreachable"));
  });

  it("serializes slow persists while probes and escalation keep running", async () => {
    vi.stubEnv("AGENTMEMORY_HEALTH_ESCALATE", "true");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const app = setup(); await flush();
    const original = app.kv.set.getMockImplementation()!;
    let release: () => void;
    let active = 0;
    let maximum = 0;
    app.kv.set.mockImplementation(async (scope, key, value) => {
      if (key === "latest") {
        active++; maximum = Math.max(maximum, active);
        if (!release) await new Promise<void>(resolve => { release = resolve; });
        await original(scope, key, value); active--;
      } else await original(scope, key, value);
    });
    await tick(); used = 20; await tick(); await tick();
    expect(maximum).toBe(1);
    release!(); await flush(); expect(app.latest().status).toBe("healthy");
    expect(kill).not.toHaveBeenCalled();
    expect(app.kv.set).toHaveBeenCalledWith(KV.health, "_probe", expect.anything());
  });
});
