import type { ISdk } from "iii-sdk";
import type { Memory, CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { deleteAccessLog } from "./access-tracker.js";
import { getSearchIndex, vectorIndexRemove, flushIndexSave } from "./search.js";
import { logger } from "../logger.js";
import {
  getObsRetentionDays,
  getObsRetentionMaxImportance,
  getObsRetentionMaxPerRun,
} from "../config.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONTRADICTION_THRESHOLD = 0.9;

// Observation retention (U5). A session qualifies by when it was last touched,
// never by status: `completed` flips on every turn and observations keep
// appending after it, so status says nothing about whether a session is done.
// The most recent of updatedAt and endedAt is the last-touched stamp; a session
// predating both fields falls back to startedAt, the way session-sweep already
// does, so the oldest sessions are not immune to retention by being old.
function lastTouched(session: Session): number {
  const stamps = [session.updatedAt, session.endedAt, session.startedAt]
    .filter((s): s is string => typeof s === "string")
    .map((s) => new Date(s).getTime())
    .filter((t) => Number.isFinite(t));
  return stamps.length > 0 ? Math.max(...stamps) : 0;
}

interface AutoForgetResult {
  ttlExpired: string[];
  contradictions: Array<{
    memoryA: string;
    memoryB: string;
    similarity: number;
  }>;
  lowValueObs: string[];
  // Eligible rows the per-run cap did not reach. The next run picks them up.
  lowValueRemaining: number;
  dryRun: boolean;
}

export function registerAutoForgetFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::auto-forget", 
    async (data: { dryRun?: boolean }): Promise<AutoForgetResult> => {
      const dryRun = data?.dryRun ?? false;
      const now = Date.now();
      const { decrementImageRef } = await import("./image-refs.js");

      const result: AutoForgetResult = {
        ttlExpired: [],
        contradictions: [],
        lowValueObs: [],
        lowValueRemaining: 0,
        dryRun,
      };

      const memories = await kv.list<Memory>(KV.memories);
      const deletedIds = new Set<string>();
      for (const mem of memories) {
        if (mem.forgetAfter) {
          const expiry = new Date(mem.forgetAfter).getTime();
          if (now > expiry) {
            result.ttlExpired.push(mem.id);
            deletedIds.add(mem.id);
            if (!dryRun) {
              if (mem.imageRef) {
                await decrementImageRef(kv, sdk, mem.imageRef);
              }
              await kv.delete(KV.memories, mem.id);
              await recordAudit(kv, "delete", "mem::auto-forget", [mem.id], {
                resource: "memory",
                reason: "auto-forget TTL",
                timestamp: mem.forgetAfter,
              });
              await deleteAccessLog(kv, mem.id);
              getSearchIndex().remove(mem.id);
              vectorIndexRemove(mem.id);
            }
          }
        }
      }

      const latestMemories = memories
        .filter((m) => m.isLatest !== false && !deletedIds.has(m.id))
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 1000);

      const tokenCache = new Map<string, Set<string>>();
      for (const mem of latestMemories) {
        tokenCache.set(
          mem.id,
          new Set(
            mem.content
              .toLowerCase()
              .split(/\s+/)
              .filter((t) => t.length > 2),
          ),
        );
      }

      const memById = new Map(latestMemories.map((m) => [m.id, m]));
      const conceptIndex = new Map<string, string[]>();
      for (const mem of latestMemories) {
        const concepts = mem.concepts || [];
        for (const c of concepts) {
          const key = c.toLowerCase();
          if (!conceptIndex.has(key)) conceptIndex.set(key, []);
          conceptIndex.get(key)!.push(mem.id);
        }
      }

      const compared = new Set<string>();
      for (const [, memIds] of conceptIndex) {
        for (let i = 0; i < memIds.length; i++) {
          for (let j = i + 1; j < memIds.length; j++) {
            const key =
              memIds[i] < memIds[j]
                ? `${memIds[i]}|${memIds[j]}`
                : `${memIds[j]}|${memIds[i]}`;
            if (compared.has(key)) continue;
            compared.add(key);

            const setA = tokenCache.get(memIds[i])!;
            const setB = tokenCache.get(memIds[j])!;
            let intersection = 0;
            if (setA.size === 0 && setB.size === 0) continue;
            if (setA.size === 0 || setB.size === 0) continue;
            for (const word of setA) {
              if (setB.has(word)) intersection++;
            }
            const sim =
              intersection / (setA.size + setB.size - intersection);

            if (sim > CONTRADICTION_THRESHOLD) {
              const memA = memById.get(memIds[i])!;
              const memB = memById.get(memIds[j])!;
              result.contradictions.push({
                memoryA: memA.id,
                memoryB: memB.id,
                similarity: sim,
              });

              if (!dryRun) {
                const older =
                  new Date(memA.createdAt).getTime() <
                    new Date(memB.createdAt).getTime()
                    ? memA
                    : memB;
                older.isLatest = false;
                await kv.set(KV.memories, older.id, older);
                await recordAudit(kv, "forget", "mem::auto-forget", [older.id], {
                  resource: "memory",
                  reason: "auto-forget contradiction",
                  olderId: older.id,
                  similarity: sim,
                });
              }
            }
          }
        }
      }

      const sessions = await kv.list<Session>(KV.sessions);
      const obsPerSession: CompressedObservation[][] = [];
      for (let batch = 0; batch < sessions.length; batch += 10) {
        const chunk = sessions.slice(batch, batch + 10);
        const results = await Promise.all(
          chunk.map((s) =>
            kv
              .list<CompressedObservation>(KV.observations(s.id))
              .catch(() => [] as CompressedObservation[]),
          ),
        );
        obsPerSession.push(...results);
      }
      const retentionMs = getObsRetentionDays() * MS_PER_DAY;
      const maxImportance = getObsRetentionMaxImportance();
      const maxPerRun = getObsRetentionMaxPerRun();
      const cutoff = now - retentionMs;
      // One audit row per run, per the bulk-deletion shape audit.ts requires.
      // Per-item rows flooded the log during routine sweeps -- and were the
      // majority of what pushed mem:audit over the enumeration guard.
      const deletedObs: string[] = [];
      for (let i = 0; i < sessions.length; i++) {
        // The whole session has to be idle, not just the row. Deleting from a
        // session that later gets a turn makes events.ts re-extract the rest
        // once; the idle threshold makes that rare and the cap bounds it.
        if (lastTouched(sessions[i]) > cutoff) continue;
        for (const obs of obsPerSession[i]) {
          if (!obs.timestamp) continue;
          if (new Date(obs.timestamp).getTime() > cutoff) continue;
          // A row with no importance never had a score: a synthetic
          // compression, not a judged-unimportant one. Keep it.
          if (obs.importance === undefined || obs.importance > maxImportance) continue;
          if (result.lowValueObs.length >= maxPerRun) {
            result.lowValueRemaining++;
            continue;
          }
          result.lowValueObs.push(obs.id);
          if (!dryRun) {
            let deletedOk = false;
            try {
              await kv.delete(KV.observations(sessions[i].id), obs.id);
              deletedOk = true;
            } catch {
              deletedOk = false;
            }
            if (deletedOk) {
              if (obs.imageData) await decrementImageRef(kv, sdk, obs.imageData);
              if (obs.imageRef && obs.imageRef !== obs.imageData) {
                await decrementImageRef(kv, sdk, obs.imageRef);
              }
              deletedObs.push(obs.id);
              getSearchIndex().remove(obs.id);
              vectorIndexRemove(obs.id);
            }
          }
        }
      }
      if (deletedObs.length > 0) {
        await recordAudit(kv, "delete", "mem::auto-forget", deletedObs, {
          resource: "observation",
          reason: "auto-forget low-value observation",
          evicted: deletedObs.length,
          remaining: result.lowValueRemaining,
          retentionDays: getObsRetentionDays(),
          maxImportance,
        });
      }

      if (!dryRun && (result.ttlExpired.length > 0 || result.lowValueObs.length > 0)) {
        await flushIndexSave();
      }

      logger.info("Auto-forget complete", {
        ttlExpired: result.ttlExpired.length,
        contradictions: result.contradictions.length,
        lowValueObs: result.lowValueObs.length,
        lowValueRemaining: result.lowValueRemaining,
        dryRun,
      });
      return result;
    },
  );
}
