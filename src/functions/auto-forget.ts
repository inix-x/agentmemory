import type { IIIClient } from "iii-sdk";
import { markCaptureEventDeleted } from "../capture/event-record.js";
import type { Memory, CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { unindexObservationSession } from "../state/obs-index.js";
import { recordAudit } from "./audit.js";
import { deleteAccessLog } from "./access-tracker.js";
import { deleteFacetsForTargets } from "./facets.js";
import { getSearchIndex, vectorIndexRemove, flushIndexSave } from "./search.js";
import { logger } from "../logger.js";
import {
  getObsRetentionDays,
  getObsRetentionMaxImportance,
  getObsRetentionMaxPerRun,
} from "../config.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONTRADICTION_THRESHOLD = 0.9;

// A session is idle by when it was last touched, never by status: `completed`
// flips on every turn and observations keep appending after it. A session with
// neither updatedAt nor endedAt falls back to startedAt.
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
  // Eligible observations the per-run cap did not reach. The next run takes them.
  lowValueRemaining: number;
  dryRun: boolean;
}

export function registerAutoForgetFunction(sdk: IIIClient, kv: StateKV): void {
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
      const facetIds = new Set<string>();
      try {
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
                facetIds.add(mem.id);
                await deleteAccessLog(kv, mem.id);
                getSearchIndex().remove(mem.id);
                vectorIndexRemove(mem.id);
              }
            }
          }
        }
      } finally {
        await deleteFacetsForTargets(kv, facetIds);
        // One row per run for every memory actually deleted, written here so a
        // delete that throws partway still records the ones before it.
        if (facetIds.size > 0) {
          await recordAudit(kv, "delete", "mem::auto-forget", [...facetIds], {
            resource: "memory",
            reason: "auto-forget TTL",
            evicted: facetIds.size,
            byReason: { "auto-forget TTL": facetIds.size },
          });
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

      const demotedIds: string[] = [];
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
                demotedIds.push(older.id);
              }
            }
          }
        }
      }

      if (demotedIds.length > 0) {
        await recordAudit(kv, "forget", "mem::auto-forget", demotedIds, {
          resource: "memory",
          reason: "auto-forget contradiction",
          demoted: demotedIds.length,
          byReason: { "auto-forget contradiction": demotedIds.length },
        });
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
      const retentionDays = getObsRetentionDays();
      const maxImportance = getObsRetentionMaxImportance();
      const maxPerRun = getObsRetentionMaxPerRun();
      const cutoff = now - retentionDays * MS_PER_DAY;
      // A row with no importance was never scored, so it is kept.
      const isLowValue = (o: CompressedObservation | null): o is CompressedObservation =>
        !!o?.timestamp &&
        new Date(o.timestamp).getTime() < cutoff &&
        o.importance !== undefined &&
        o.importance <= maxImportance;
      const deletedObs: string[] = [];
      for (let i = 0; i < sessions.length; i++) {
        // The whole session has to be idle, not just the row, so a live
        // session does not lose rows its next turn would re-extract.
        if (lastTouched(sessions[i]) > cutoff) continue;
        for (const obs of obsPerSession[i]) {
          if (isLowValue(obs)) {
            if (result.lowValueObs.length >= maxPerRun) {
              result.lowValueRemaining++;
              continue;
            }
            result.lowValueObs.push(obs.id);
            if (!dryRun) {
              let removed: CompressedObservation | null = null;
              try {
                removed = await withKeyedLock(`obs:${sessions[i].id}`, async () => {
                  const current = await kv.get<CompressedObservation>(KV.observations(sessions[i].id), obs.id);
                  if (!isLowValue(current)) return null;
                  await markCaptureEventDeleted(kv, current);
                  await kv.delete(KV.observations(sessions[i].id), obs.id);
                  getSearchIndex().remove(obs.id);
                  vectorIndexRemove(obs.id);
                  return current;
                });
              } catch {
                logger.warn("Auto-forget observation cleanup failed");
              }
              if (removed) {
                await unindexObservationSession(kv, obs.id).catch(() => {});
                if (removed.imageData) await decrementImageRef(kv, sdk, removed.imageData);
                if (removed.imageRef && removed.imageRef !== removed.imageData) {
                  await decrementImageRef(kv, sdk, removed.imageRef);
                }
                deletedObs.push(obs.id);
              }
            }
          }
        }
      }
      if (deletedObs.length > 0) {
        await recordAudit(kv, "delete", "mem::auto-forget", deletedObs, {
          resource: "observation",
          reason: "auto-forget low-value observation",
          evicted: deletedObs.length,
          byReason: { "auto-forget low-value observation": deletedObs.length },
          remaining: result.lowValueRemaining,
          retentionDays,
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
