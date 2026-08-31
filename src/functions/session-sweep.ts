import { TriggerAction, type ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";

// Sessions only reach "completed" when a client POSTs /agentmemory/session/end.
// Clients that never send it leave sessions "active" forever, so this ages them
// on inactivity instead — no termination event required, whichever harness
// dropped it. Separate from mem::evict on purpose: that pass deletes rows, which
// is a different decision from marking a session finished.
const MS_PER_MINUTE = 60 * 1000;
const DEFAULT_IDLE_MINUTES = 60;
// ponytail: fixed cap per run, not a work queue. Each swept session fans out a
// summarize, so an unbounded first pass over a backlog is an LLM storm.
const MAX_PER_RUN = 25;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function lastActivity(session: Session): number {
  const stamp = session.updatedAt ?? session.startedAt;
  const parsed = stamp ? new Date(stamp).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function registerSessionSweepFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::session-sweep",
    async (data: {
      dryRun?: boolean;
      idleMinutes?: number;
    }): Promise<{ success: true; candidates: number; swept: number }> => {
      const dryRun = data?.dryRun ?? false;
      const idleMinutes = positiveNumber(
        data?.idleMinutes,
        DEFAULT_IDLE_MINUTES,
      );
      const idleMs = idleMinutes * MS_PER_MINUTE;

      const now = Date.now();
      const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      let candidates = 0;
      let swept = 0;

      for (const session of sessions) {
        if (session.status !== "active") continue;
        const last = lastActivity(session);
        // Treating an unreadable stamp as infinitely idle would end live
        // sessions, so skip rather than sweep.
        if (!Number.isFinite(last)) continue;
        if (now - last <= idleMs) continue;

        candidates++;
        if (dryRun) continue;
        if (swept >= MAX_PER_RUN) continue;

        try {
          // event::session::ended owns the terminal-state write.
          await sdk.trigger({
            function_id: "event::session::ended",
            payload: { sessionId: session.id },
          });
        } catch (err) {
          logger.warn("Session sweep failed to end session", {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        swept++;

        // safeAudit, not recordAudit: an audit write that times out must not
        // abort the run for every session behind this one.
        await safeAudit(kv, "session_sweep", "mem::session-sweep", [session.id], {
          resource: "session",
          reason: "idle_timeout",
          idleMinutes,
        });

        // Mirrors the /session/end fan-out. skipConsolidation keeps N swept
        // sessions from launching N full-corpus consolidations.
        sdk
          .trigger({
            function_id: "event::session::stopped",
            payload: { sessionId: session.id, skipConsolidation: true },
            action: TriggerAction.Void(),
          })
          .catch((err: unknown) => {
            logger.warn("Session sweep summary fan-out failed", {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      if (candidates > 0) {
        logger.info("Session sweep complete", {
          candidates,
          swept,
          idleMinutes,
          dryRun,
        });
      }
      return { success: true, candidates, swept };
    },
  );
}
