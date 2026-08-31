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
// A day, not an hour. The sessions this exists for (SDK children, subagents)
// run and finish, so a tight threshold buys nothing there, while a client that
// merely idles overnight would be ended mid-use. mem::evict's comparable
// "this is dead" call is 30 days.
const DEFAULT_IDLE_MINUTES = 1440;
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
      let attempted = 0;
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
        // Cap attempts, not successes: if every end fails, a large backlog
        // would otherwise retry the whole list on every run.
        if (attempted >= MAX_PER_RUN) continue;
        attempted++;

        try {
          // event::session::ended owns the terminal-state write. Pass the last
          // activity as endedAt so a session idle for a day is not recorded as
          // having run for a day (the viewer derives duration from it).
          await sdk.trigger({
            function_id: "event::session::ended",
            payload: {
              sessionId: session.id,
              endedAt: new Date(last).toISOString(),
            },
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

        // Same summary fan-out /session/end performs, except for
        // skipConsolidation, which that path does not pass: it ends one session
        // at a time, whereas this can end MAX_PER_RUN of them and would
        // otherwise launch that many full-corpus consolidations.
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
