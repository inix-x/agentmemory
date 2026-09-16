import { evaluateMemory, MEMORY_DEFAULTS } from "./memory.js";
import type { MemoryConfig } from "./memory.js";
import type { HealthSnapshot } from "../types.js";

interface ThresholdConfig extends Omit<MemoryConfig, "memoryHoldSamples"> {
  eventLoopLagWarnMs: number;
  eventLoopLagCriticalMs: number;
  cpuWarnPercent: number;
  cpuCriticalPercent: number;
}

const DEFAULTS: ThresholdConfig = {
  eventLoopLagWarnMs: 100,
  eventLoopLagCriticalMs: 500,
  cpuWarnPercent: 80,
  cpuCriticalPercent: 90,
  ...MEMORY_DEFAULTS,
};

export function evaluateHealth(
  snapshot: HealthSnapshot,
  config: Partial<ThresholdConfig> = {},
  memoryEvaluations = evaluateMemory(snapshot.memory, { ...DEFAULTS, ...config }),
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

  for (const evaluation of memoryEvaluations) {
    const signal = `${evaluation.source}${evaluation.path ?? ""}`;
    if (!evaluation.available) notes.push(`memory_unavailable_${signal}`);
    if (evaluation.transition) notes.push(`memory_${evaluation.transition}_${signal}`);
    if (evaluation.severity === "critical") critical = true;
    if (evaluation.severity === "degraded") degraded = true;
    if (evaluation.severity !== "healthy") {
      alerts.push(`memory_${evaluation.severity === "critical" ? "critical" : "warn"}_${signal}_${evaluation.percent === undefined ? "unavailable" : `${Math.round(evaluation.percent)}%`}`);
    }
  }

  const status = critical ? "critical" : degraded ? "degraded" : "healthy";
  return { status, alerts, notes };
}
