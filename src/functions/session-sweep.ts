import { TriggerAction, type ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";

// A session only reaches "completed" when a client POSTs
// /agentmemory/session/end (src/triggers/api.ts). Several clients never do:
// the Claude Code Stop hook returns early for Agent SDK child sessions
// (src/hooks/stop.ts) and subagent-stop.ts posts observations only, while the
// opencode plugin posts it solely on session.deleted. Those sessions stay
// "active" forever.
//
// This sweep keys on inactivity rather than on any termination event, so it
// closes them regardless of which harness dropped the signal. It deliberately
// does NOT live in mem::evict: that pass deletes session rows and observations,
// which is a different decision from marking a session finished.
interface SweepConfig {
  idleMinutes: number;
  maxPerRun: number;
}

const MS_PER_MINUTE = 60 * 1000;

const DEFAULTS: SweepConfig = {
  idleMinutes: 60,
  // ponytail: fixed cap per run, not a work queue. Each swept session fans out
  // a summarize, so an unbounded first run over a large backlog is an LLM
  // storm. Raise it if a backlog drains too slowly.
  maxPerRun: 25,
};

interface SweepStats {
  candidates: number;
  swept: number;
  dryRun: boolean;
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
    }): Promise<SweepStats> => {
      const dryRun = data?.dryRun ?? false;

      const configOverride = await kv
        .get<Partial<SweepConfig>>(KV.config, "sessionSweep")
        .catch(() => null);
      const cfg = { ...DEFAULTS, ...configOverride };
      const idleMinutes = data?.idleMinutes ?? cfg.idleMinutes;
      const idleMs = idleMinutes * MS_PER_MINUTE;

      const now = Date.now();
      const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      const stats: SweepStats = { candidates: 0, swept: 0, dryRun };

      for (const session of sessions) {
        if (session.status !== "active") continue;
        const last = lastActivity(session);
        // A session with no usable timestamp cannot be aged; leaving it alone
        // is safer than treating an unparseable stamp as "infinitely idle".
        if (!Number.isFinite(last)) continue;
        if (now - last <= idleMs) continue;

        stats.candidates++;
        if (dryRun) continue;
        if (stats.swept >= cfg.maxPerRun) continue;

        try {
          // event::session::ended owns the terminal-state write (endedAt +
          // status). Reuse it rather than re-implementing the kv.update here.
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
        stats.swept++;

        // Match what /agentmemory/session/end fans out, so a swept session
        // reaches the same terminal shape as a normally-ended one.
        // skipConsolidation keeps N swept sessions from launching N full-corpus
        // consolidations, the same guard eviction's recovery path uses.
        sdk.trigger({
          function_id: "event::session::stopped",
          payload: { sessionId: session.id, skipConsolidation: true },
          action: TriggerAction.Void(),
        }).catch((err: unknown) => {
          logger.warn("Session sweep summary fan-out failed", {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      if (stats.swept > 0 || stats.candidates > 0) {
        logger.info("Session sweep completed", {
          candidates: stats.candidates,
          swept: stats.swept,
          idleMinutes,
          dryRun,
        });
      }
      return stats;
    },
  );
}
