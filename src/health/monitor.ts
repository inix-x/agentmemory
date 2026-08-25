import { getHeapStatistics } from "node:v8";
import type { ISdk } from "iii-sdk";
import type { HealthSnapshot } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { evaluateHealth } from "./thresholds.js";

export interface EscalationState {
  /** Consecutive snapshots whose KV probe failed. Reset by any healthy probe. */
  consecutiveStalls: number;
  /** Set once a healthy KV probe has been seen. Nothing escalates before then. */
  armed: boolean;
  escalated: boolean;
}

/**
 * Advance the stall counter and report whether the process should exit.
 *
 * Gated on the KV probe specifically, NOT on `snapshot.status`. `evaluateHealth`
 * raises `critical` from five independent conditions (connection, KV, event-loop
 * lag, CPU, memory), so gating on the aggregate would let a CPU spike during a
 * consolidation pass kill a process that is not wedged at all.
 *
 * `armed` mirrors the shell watchdog's "wait for a first success" rule. Without
 * it, a store that is already stalled at boot escalates on the first minute of
 * every container life, which spends the platform's restart budget in minutes
 * and ends at a stopped deployment.
 *
 * Call this BEFORE persisting the snapshot. The persist is not raced against any
 * timeout, and a stalled store parks it for the engine's full invocation timeout,
 * so a counter behind it would never advance during the failure it exists to
 * catch.
 */
export function bumpEscalation(
  snapshot: HealthSnapshot,
  state: EscalationState,
  threshold: number,
): boolean {
  const stalled = snapshot.kvConnectivity?.status === "error";
  if (!stalled) {
    state.armed = true;
    state.consecutiveStalls = 0;
    return false;
  }
  if (!state.armed) return false;
  state.consecutiveStalls += 1;
  if (state.escalated || state.consecutiveStalls < threshold) return false;
  state.escalated = true;
  return true;
}

export function registerHealthMonitor(
  sdk: ISdk,
  kv: StateKV,
): { stop: () => void } {
  const escalationState: EscalationState = {
    consecutiveStalls: 0,
    armed: false,
    escalated: false,
  };
  // Default off. Enabling this arms an automatic process-killer, so it stays
  // opt-in until external uptime monitoring exists to make a restart loop
  // visible. The threshold spans 5 minutes at the 30s collection interval,
  // deliberately wider than the write bursts this codebase already documents
  // as able to exceed the engine's own 30s timeout (see src/index.ts).
  const escalateEnabled = process.env["AGENTMEMORY_HEALTH_ESCALATE"] === "1" ||
    process.env["AGENTMEMORY_HEALTH_ESCALATE"]?.toLowerCase() === "true";
  const escalateAfter = 10;

  function escalate(alerts: string[]): void {
    console.error(
      `[agentmemory] health escalation: KV unreachable for ${escalateAfter} consecutive checks (${alerts.join(", ")}); exiting so the platform restarts`,
    );
    // Prefer the registered SIGTERM shutdown so the index flushes. That handler
    // ends in process.exit(0), so railway.json uses restartPolicyType ALWAYS —
    // ON_FAILURE would read a graceful exit as success and never restart.
    process.kill(process.pid, "SIGTERM");
    // NOT unref'd. If shutdown parks on the same stalled store, this is the only
    // thing that still reaches an exit.
    setTimeout(() => {
      console.error(
        "[agentmemory] health escalation: graceful shutdown did not finish; forcing exit",
      );
      process.exit(1);
    }, 15_000);
  }

  let connectionState = "connected";
  let prevCpuUsage = process.cpuUsage();
  let prevCpuTime = Date.now();

  if (typeof sdk.on === "function") {
    sdk.on("connection_state", (state?: unknown) => {
      connectionState = state as string;
    });
  }

  async function collectHealth(): Promise<HealthSnapshot> {
    const mem = process.memoryUsage();
    const currentCpu = process.cpuUsage();
    const now = Date.now();
    const uptime = process.uptime();

    const elapsedMs = now - prevCpuTime;
    const userDelta = currentCpu.user - prevCpuUsage.user;
    const systemDelta = currentCpu.system - prevCpuUsage.system;
    const cpuPercent =
      elapsedMs > 0 ? ((userDelta + systemDelta) / 1000 / elapsedMs) * 100 : 0;
    prevCpuUsage = currentCpu;
    prevCpuTime = now;

    const startMark = performance.now();
    await new Promise((resolve) => setImmediate(resolve));
    const eventLoopLagMs = performance.now() - startMark;

    let workers: HealthSnapshot["workers"] = [];
    // Raced, like the KV probe below. Unraced, this inherits the engine's
    // invocation timeout (180s), so a dead engine parks the whole collection
    // here -- upstream of the probe and of the escalation decision -- and
    // detection slips from minutes to tens of minutes.
    const WORKERS_PROBE_TIMEOUT = 5000;
    try {
      const result = await Promise.race([
        sdk.trigger<unknown, { workers?: HealthSnapshot["workers"] }>({
          function_id: "engine::workers::list",
          payload: {},
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), WORKERS_PROBE_TIMEOUT),
        ),
      ]);
      if (result?.workers) workers = result.workers;
    } catch {}

    const KV_PROBE_TIMEOUT = 5000;
    let kvConnectivity: { status: string; latencyMs?: number; error?: string };
    const kvStart = performance.now();
    try {
      await Promise.race([
        (async () => {
          await kv.set(KV.health, "_probe", { ts: Date.now() });
          await kv.get(KV.health, "_probe");
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), KV_PROBE_TIMEOUT),
        ),
      ]);
      kvConnectivity = { status: "ok", latencyMs: Math.round((performance.now() - kvStart) * 100) / 100 };
    } catch {
      kvConnectivity = { status: "error", error: "kv_probe_failed", latencyMs: Math.round((performance.now() - kvStart) * 100) / 100 };
    }

    const snapshot: HealthSnapshot = {
      connectionState,
      workers,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        heapSizeLimit: getHeapStatistics().heap_size_limit,
      },
      cpu: {
        userMicros: currentCpu.user,
        systemMicros: currentCpu.system,
        percent: Math.round(cpuPercent * 100) / 100,
      },
      eventLoopLagMs,
      uptimeSeconds: uptime,
      kvConnectivity,
      status: "healthy",
      alerts: [],
    };

    const evaluated = evaluateHealth(snapshot);
    snapshot.status = evaluated.status;
    snapshot.alerts = evaluated.alerts;
    snapshot.notes = evaluated.notes;

    // Decide before the persist below, which races no timeout.
    if (escalateEnabled && bumpEscalation(snapshot, escalationState, escalateAfter)) {
      escalate(snapshot.alerts);
    }

    await kv.set(KV.health, "latest", snapshot).catch(() => {});
    return snapshot;
  }

  collectHealth().catch(() => {});
  const interval = setInterval(() => {
    collectHealth().catch(() => {});
  }, 30_000);
  interval.unref();

  return {
    stop: () => clearInterval(interval),
  };
}

export async function getLatestHealth(
  kv: StateKV,
): Promise<HealthSnapshot | null> {
  return kv.get<HealthSnapshot>(KV.health, "latest");
}
