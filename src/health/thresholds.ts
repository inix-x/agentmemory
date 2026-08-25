import type { HealthSnapshot } from "../types.js";

interface ThresholdConfig {
  eventLoopLagWarnMs: number;
  eventLoopLagCriticalMs: number;
  cpuWarnPercent: number;
  cpuCriticalPercent: number;
  memoryWarnPercent: number;
  memoryCriticalPercent: number;
  memoryRssFloorBytes: number;
}

const DEFAULTS: ThresholdConfig = {
  eventLoopLagWarnMs: 100,
  eventLoopLagCriticalMs: 500,
  cpuWarnPercent: 80,
  cpuCriticalPercent: 90,
  memoryWarnPercent: 80,
  memoryCriticalPercent: 95,
  memoryRssFloorBytes: 512 * 1024 * 1024,
};

export function evaluateHealth(
  snapshot: HealthSnapshot,
  config: Partial<ThresholdConfig> = {},
): { status: "healthy" | "degraded" | "critical"; alerts: string[]; notes: string[] } {
  const cfg = { ...DEFAULTS, ...config };
  const alerts: string[] = [];
  const notes: string[] = [];
  let critical = false;
  let degraded = false;

  // NOTE: unreachable in production today. iii-sdk's setConnectionState only
  // assigns a private field and emits nothing, so the "connection_state"
  // listener in monitor.ts never fires and connectionState stays "connected"
  // for the life of the process. Kept because the field is part of the
  // snapshot contract and a future SDK may emit it; do not rely on it as a
  // liveness signal until it does.
  if (
    snapshot.connectionState === "disconnected" ||
    snapshot.connectionState === "failed"
  ) {
    alerts.push(`connection_${snapshot.connectionState}`);
    critical = true;
  } else if (snapshot.connectionState === "reconnecting") {
    alerts.push("connection_reconnecting");
    degraded = true;
  }

  // The KV probe in collectHealth is the only check that exercises the state
  // store end to end (set then get, raced against a 5s timeout). A store that
  // stops answering takes the HTTP workers down with it, so a failed probe is
  // the earliest reliable signal of that failure and belongs at critical.
  // kvConnectivity is optional on the snapshot, and older persisted snapshots
  // predate it, so an absent or malformed value must read as "no signal"
  // rather than as a failure.
  if (snapshot.kvConnectivity?.status === "error") {
    alerts.push("kv_probe_failed");
    critical = true;
  }

  if (snapshot.eventLoopLagMs > cfg.eventLoopLagCriticalMs) {
    alerts.push(
      `event_loop_lag_critical_${Math.round(snapshot.eventLoopLagMs)}ms`,
    );
    critical = true;
  } else if (snapshot.eventLoopLagMs > cfg.eventLoopLagWarnMs) {
    alerts.push(`event_loop_lag_warn_${Math.round(snapshot.eventLoopLagMs)}ms`);
    degraded = true;
  }

  if (snapshot.cpu.percent > cfg.cpuCriticalPercent) {
    alerts.push(`cpu_critical_${Math.round(snapshot.cpu.percent)}%`);
    critical = true;
  } else if (snapshot.cpu.percent > cfg.cpuWarnPercent) {
    alerts.push(`cpu_warn_${Math.round(snapshot.cpu.percent)}%`);
    degraded = true;
  }

  // heapTotal is what V8 has committed so far, not what it may grow to, and V8
  // sizes it to demand — so a healthy busy process sits near 100% of it
  // permanently. Measure against heap_size_limit when the snapshot carries it.
  const heapCeiling =
    snapshot.memory.heapSizeLimit && snapshot.memory.heapSizeLimit > 0
      ? snapshot.memory.heapSizeLimit
      : snapshot.memory.heapTotal;
  const memPercent =
    heapCeiling > 0 ? (snapshot.memory.heapUsed / heapCeiling) * 100 : 0;
  const rss = snapshot.memory.rss ?? 0;
  const rssAboveFloor = rss >= cfg.memoryRssFloorBytes;
  const memMb = Math.round(rss / (1024 * 1024));
  if (memPercent > cfg.memoryCriticalPercent && rssAboveFloor) {
    alerts.push(`memory_critical_${Math.round(memPercent)}%_rss${memMb}mb`);
    critical = true;
  } else if (memPercent > cfg.memoryWarnPercent && rssAboveFloor) {
    alerts.push(`memory_warn_${Math.round(memPercent)}%_rss${memMb}mb`);
    degraded = true;
  } else if (memPercent > cfg.memoryWarnPercent) {
    notes.push(`memory_heap_tight_${Math.round(memPercent)}%_rss${memMb}mb`);
  }

  const status = critical ? "critical" : degraded ? "degraded" : "healthy";
  return { status, alerts, notes };
}
