import { describe, expect, it } from "vitest";
import { evaluateHealth } from "../src/health/thresholds.js";
import type { HealthSnapshot } from "../src/types.js";

function snap(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    connectionState: "connected",
    workers: [],
    memory: { heapUsed: 0, heapTotal: 1, rss: 0, external: 0 },
    cpu: { userMicros: 0, systemMicros: 0, percent: 0 },
    eventLoopLagMs: 0,
    uptimeSeconds: 1,
    kvConnectivity: { status: "ok", latencyMs: 1 },
    status: "healthy",
    alerts: [],
    ...over,
  };
}

describe("independent real memory budgets", () => {
  it.each([
    [390_771_624, 404_930_560, 6_492_782_592],
    [267_970_328, 277_663_744, 2_197_815_296],
  ])("keeps the reported committed heap %s healthy", (heapUsed, heapTotal, heapSizeLimit) => {
    expect(evaluateHealth(snap({ memory: { heapUsed, heapTotal, heapSizeLimit, rss: 600_000_000, external: 0 } })).status).toBe("healthy");
  });

  it("does not invent a budget for old snapshots", () => {
    const result = evaluateHealth(snap({ memory: { heapUsed: 970, heapTotal: 1000, rss: 900_000_000, external: 0 } }));
    expect(result.status).toBe("healthy");
    expect(result.notes).toContain("memory_unavailable_heap");
  });

  it.each([[80, "healthy"], [81, "degraded"], [95, "degraded"], [96, "critical"]])("evaluates small heaps at %s percent without an RSS floor", (heapUsed, expected) => {
    expect(evaluateHealth(snap({ memory: { heapUsed: Number(heapUsed), heapTotal: 100, heapSizeLimit: 100, rss: 200, external: 0 } })).status).toBe(expected);
  });

  it("keeps heap and cgroup signals independent", () => {
    const memory = { heapUsed: 96, heapTotal: 100, heapSizeLimit: 100, rss: 200, external: 0, cgroup: { status: "available" as const, levels: [{ path: "/", current: 100, max: 1000 }] } };
    expect(evaluateHealth(snap({ memory })).status).toBe("critical");
    memory.heapUsed = 10;
    memory.cgroup.levels[0].current = 960;
    expect(evaluateHealth(snap({ memory })).status).toBe("critical");
  });

  it("reports memory.high as warning even beyond its boundary", () => {
    const result = evaluateHealth(snap({ memory: { heapUsed: 1, heapTotal: 100, external: 0, rss: 2, cgroup: { status: "available", levels: [{ path: "/", current: 110, high: 100 }] } } }));
    expect(result.status).toBe("degraded");
    expect(result.alerts).toContain("memory_warn_cgroup-high/_110%");
  });

  it("evaluates an explicit RSS budget alongside low cgroup occupancy", () => {
    const result = evaluateHealth(snap({ memory: { heapUsed: 1, heapTotal: 100, external: 0, rss: 110, cgroup: { status: "available", levels: [{ path: "/", current: 110, max: 1000 }] } } }), { memoryRssBudgetBytes: 100 });
    expect(result.status).toBe("critical");
    expect(result.alerts).toContain("memory_critical_rss_110%");
  });

  it.each([0, -1, Infinity, NaN])("rejects invalid V8 limit %s", heapSizeLimit => {
    expect(evaluateHealth(snap({ memory: { heapUsed: 99, heapTotal: 100, heapSizeLimit, rss: 1_000_000_000, external: 0 } })).status).toBe("healthy");
  });
});

describe("non-memory signals", () => {
  it.each([
    { cpu: { userMicros: 0, systemMicros: 0, percent: 91 } },
    { eventLoopLagMs: 501 },
    { connectionState: "failed" },
  ])("keeps critical conditions immediate during memory entry: %s", other => {
    expect(evaluateHealth(snap(other), {}, [{ source: "heap", available: true, percent: 99, severity: "degraded", transition: "entering" }]).status).toBe("critical");
  });
});

describe("evaluateHealth KV connectivity", () => {
  it("goes critical when the KV probe fails", () => {
    const s = snap({
      kvConnectivity: { status: "error", error: "kv_probe_failed", latencyMs: 5000 },
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("critical");
    expect(alerts).toContain("kv_probe_failed");
  });

  it("adds no KV alert when the probe succeeds", () => {
    const { status, alerts } = evaluateHealth(snap());
    expect(status).toBe("healthy");
    expect(alerts.find((a) => a.startsWith("kv_"))).toBeUndefined();
  });

  // kvConnectivity is optional on HealthSnapshot, and snapshots persisted before
  // the field existed still come back from KV, so absence must read as "no
  // signal" rather than as a failure.
  it("stays healthy when kvConnectivity is absent", () => {
    const s = snap();
    delete s.kvConnectivity;
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("healthy");
    expect(alerts.find((a) => a.startsWith("kv_"))).toBeUndefined();
  });

  it("does not throw or alert on a malformed kvConnectivity", () => {
    const s = snap({ kvConnectivity: { status: undefined as unknown as string } });
    expect(() => evaluateHealth(s)).not.toThrow();
    expect(evaluateHealth(s).alerts.find((a) => a.startsWith("kv_"))).toBeUndefined();
  });

  it("reports the KV alert alongside other critical signals", () => {
    const s = snap({
      kvConnectivity: { status: "error", error: "kv_probe_failed" },
      eventLoopLagMs: 900,
    });
    const { status, alerts } = evaluateHealth(s);
    expect(status).toBe("critical");
    expect(alerts).toContain("kv_probe_failed");
    expect(alerts.find((a) => a.startsWith("event_loop_lag_critical_"))).toBeDefined();
  });
});
