import type { IIIClient } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import { deleteAccessLog } from "./access-tracker.js";
import { deleteFacetsForTargets } from "./facets.js";
import { CONSOLIDATION_LAST_RUN_KEY } from "./consolidation-status.js";
import { getConsolidationDecayDays, isConsolidationEnabled } from "../config.js";
import { logger } from "../logger.js";

function applyDecay(
  items: Array<{
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
    lastDecayedAt?: string;
  }>,
  decayDays: number,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const lastAccessTime = new Date(lastAccess).getTime();
    const lastDecayedTime = item.lastDecayedAt
      ? new Date(item.lastDecayedAt).getTime()
      : -Infinity;
    const anchor = Math.max(lastAccessTime, lastDecayedTime);
    const daysSince = (now - anchor) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
      item.lastDecayedAt = new Date(now).toISOString();
    }
  }
}

const DECAY_STRENGTH_EPSILON = 1e-9;

function strengthChanged(before: number, after: number): boolean {
  return Math.abs(after - before) > DECAY_STRENGTH_EPSILON;
}

async function decayAndWriteChanged<
  T extends {
    id: string;
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
    lastDecayedAt?: string;
  },
>(
  kv: StateKV,
  scope: string,
  items: T[],
  decayDays: number,
): Promise<{ scanned: number; written: number }> {
  const before = items.map((item) => item.strength);
  applyDecay(items, decayDays);
  const dirty = items.filter((item, i) => strengthChanged(before[i], item.strength));
  for (const item of dirty) {
    await kv.set(scope, item.id, item);
  }
  return { scanned: items.length, written: dirty.length };
}

/**
 * Key within KV.config: the newest summary the semantic tier consumed (or
 * skipped after repeated failed runs), as its
 * createdAt plus sessionId so two summaries with one createdAt stay ordered.
 * A value written before the id existed covers every summary at that time.
 */
const SEMANTIC_WATERMARK_KEY = "consolidation:semanticWatermark";
const SEMANTIC_BATCH_SIZE = 20;

type SemanticCursor = { at: number; id?: string };

function isAfterCursor(at: number, id: string, cursor: SemanticCursor): boolean {
  return at > cursor.at || (at === cursor.at && cursor.id !== undefined && id > cursor.id);
}

// Throws on a read error: treating it as "no watermark" would take the seed
// path and jump the cursor past the whole backlog.
async function readSemanticCursor(kv: StateKV): Promise<SemanticCursor | null> {
  const stored = await kv.get<{ at?: string; id?: string }>(KV.config, SEMANTIC_WATERMARK_KEY);
  return stored?.at ? { at: new Date(stored.at).getTime(), id: stored.id } : null;
}

// Overlapping runs can finish out of order; never move the watermark back.
async function advanceSemanticCursor(kv: StateKV, newest: SessionSummary): Promise<void> {
  const stored = await readSemanticCursor(kv);
  if (!stored || isAfterCursor(new Date(newest.createdAt).getTime(), newest.sessionId, stored)) {
    await kv.set(KV.config, SEMANTIC_WATERMARK_KEY, {
      at: newest.createdAt,
      id: newest.sessionId,
    });
  }
}

/**
 * Key within KV.config: consecutive content failures on one batch, keyed to the
 * batch's oldest summary. The drain re-selects the same oldest batch until a
 * run succeeds, so a batch the provider always refuses would block every later
 * summary. After SEMANTIC_MAX_BATCH_FAILURES the watermark moves past it.
 */
const SEMANTIC_FAILED_BATCH_KEY = "consolidation:semanticFailedBatch";
const SEMANTIC_MAX_BATCH_FAILURES = 3;
const NO_FACTS_ERROR = "no facts parsed from the merge response";
// 408/429 are transient; 401/402/403/404 are provider config outages that fail
// every batch alike. Neither says anything about this batch.
const NOT_BATCH_SPECIFIC_4XX = new Set([401, 402, 403, 404, 408, 429]);

/**
 * True when the failure is caused by this batch's content: a reply with no
 * facts and no closed list (a refusal, prose, or empty reply), or a provider
 * 4xx that rejects the request itself. Transport failures (network, timeout,
 * 5xx, an open circuit breaker), provider outages, and KV errors return false
 * so they neither count toward a skip nor reset the count.
 */
function isSemanticContentFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === NO_FACTS_ERROR) return true;
  // Anthropic SDK errors carry a numeric status; the fetch-based providers
  // put it in the message: "OpenAI API error (400):", "MiniMax API error 400:".
  const raw = (err as { status?: unknown }).status;
  const status =
    typeof raw === "number" ? raw : Number(/API error \(?(\d{3})\)?:/.exec(err.message)?.[1]);
  return status >= 400 && status < 500 && !NOT_BATCH_SPECIFIC_4XX.has(status);
}

async function recordSemanticFailure(kv: StateKV, batch: SessionSummary[]): Promise<void> {
  const head = batch[0]!;
  const prev = await kv.get<{ id: string; at: string; count: number }>(
    KV.config,
    SEMANTIC_FAILED_BATCH_KEY,
  );
  const count =
    prev?.id === head.sessionId && prev.at === head.createdAt ? prev.count + 1 : 1;
  if (count < SEMANTIC_MAX_BATCH_FAILURES) {
    await kv.set(KV.config, SEMANTIC_FAILED_BATCH_KEY, {
      id: head.sessionId,
      at: head.createdAt,
      count,
    });
    return;
  }
  await advanceSemanticCursor(kv, batch[batch.length - 1]!);
  const sessionIds = batch.map((s) => s.sessionId);
  logger.warn("Semantic batch skipped after repeated failed runs", {
    failures: count,
    sessionIds,
  });
  await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", sessionIds, {
    resource: "semantic",
    reason: `semantic batch failed ${count} runs in a row`,
  });
  // Best-effort: the head is now behind the cursor, so a stale count never matches.
  await kv.delete(KV.config, SEMANTIC_FAILED_BATCH_KEY).catch(() => {});
}

export const SEMANTIC_MAX_ROWS = 10_000;

/**
 * Deletes the weakest rows past SEMANTIC_MAX_ROWS: never-reinforced facts
 * first, least recently accessed first among those, lower strength on a tie.
 * Reinforced facts outlive one-off extractions however old they are, and a new
 * fact goes only after every older one-off. No other path bounds the scope, so
 * without this it grows on every merge. Cleanup mirrors mem::retention-evict.
 */
async function evictPastCap(
  kv: StateKV,
  rows: SemanticMemory[],
): Promise<string[]> {
  if (rows.length <= SEMANTIC_MAX_ROWS) return [];
  const weakestFirst = [...rows].sort(
    (a, b) =>
      a.accessCount - b.accessCount ||
      (a.lastAccessedAt ?? "").localeCompare(b.lastAccessedAt ?? "") ||
      a.strength - b.strength,
  );
  const evicted = weakestFirst
    .slice(0, rows.length - SEMANTIC_MAX_ROWS)
    .map((row) => row.id);
  for (const id of evicted) {
    await kv.delete(KV.semantic, id);
    await kv.delete(KV.retentionScores, id);
    await deleteAccessLog(kv, id);
  }
  await deleteFacetsForTargets(kv, evicted);
  return evicted;
}

export function registerConsolidationPipelineFunction(
  sdk: IIIClient,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::consolidate-pipeline", 
    async (data?: { tier?: string; force?: boolean; project?: string }) => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY, or AGENTMEMORY_ALLOW_AGENT_SDK=true). OPENAI_BASE_URL alone only points an OpenAI key at another server; it is not a provider." };
      }
      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};

      if (tier === "all" || tier === "semantic") {
        const summaries = await kv.list<SessionSummary>(KV.summaries);
        const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);

        // Only summaries written since the last successful semantic run, oldest
        // first, 20 per run, so a backlog drains over several runs. Re-sending the
        // same newest 20 every run let each rewording of a known fact past the
        // exact-text dedupe below. With no watermark yet, the first run takes the
        // newest 20 instead of walking the whole history. A re-summarized session
        // gets a fresh createdAt, so it is merged again. A future-dated summary
        // (clock skew) waits until its time, so it never holds the watermark ahead.
        let cursor: SemanticCursor | null = null;
        let cursorError: string | undefined;
        try {
          cursor = await readSemanticCursor(kv);
        } catch (err) {
          cursorError = err instanceof Error ? err.message : String(err);
        }
        const selectedAt = Date.now();
        const pending = summaries
          .map((s) => ({ s, at: new Date(s.createdAt).getTime() }))
          .filter(
            ({ s, at }) =>
              at <= selectedAt && (!cursor || isAfterCursor(at, s.sessionId, cursor)),
          )
          .sort(
            (a, b) =>
              a.at - b.at || (a.s.sessionId < b.s.sessionId ? -1 : a.s.sessionId > b.s.sessionId ? 1 : 0),
          )
          .map(({ s }) => s);
        const recentSummaries = cursor
          ? pending.slice(0, SEMANTIC_BATCH_SIZE)
          : pending.slice(-SEMANTIC_BATCH_SIZE);

        if (cursorError) {
          logger.error("Semantic consolidation failed", { error: cursorError });
          results.semantic = { error: cursorError };
        } else if (summaries.length >= 5 && recentSummaries.length === 0) {
          results.semantic = {
            skipped: true,
            reason: "no summaries since the last semantic run",
          };
        } else if (summaries.length >= 5) {
          const prompt = buildSemanticMergePrompt(
            recentSummaries.map((s) => ({
              title: s.title,
              narrative: s.narrative,
              concepts: s.concepts,
            })),
          );

          try {
            const response = await provider.summarize(
              SEMANTIC_MERGE_SYSTEM,
              prompt,
            );

            const factRegex = /<fact\s+confidence="([^"]+)">([^<]+)<\/fact>/g;
            let match;
            let newFacts = 0;
            let parsedFacts = 0;
            const now = new Date().toISOString();

            while ((match = factRegex.exec(response)) !== null) {
              parsedFacts++;
              const parsedConf = parseFloat(match[1]);
              const confidence = Number.isNaN(parsedConf) ? 0.5 : parsedConf;
              const fact = match[2].trim();

              const existing = existingSemantic.find(
                (s) => s.fact.toLowerCase() === fact.toLowerCase(),
              );
              if (existing) {
                existing.accessCount++;
                existing.lastAccessedAt = now;
                existing.updatedAt = now;
                existing.confidence = Math.max(existing.confidence, confidence);
                await kv.set(KV.semantic, existing.id, existing);
              } else {
                const sem: SemanticMemory = {
                  id: generateId("sem"),
                  fact,
                  confidence,
                  sourceSessionIds: recentSummaries.map((s) => s.sessionId),
                  sourceMemoryIds: [],
                  accessCount: 1,
                  lastAccessedAt: now,
                  strength: confidence,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.semantic, sem.id, sem);
                newFacts++;
                existingSemantic.push(sem);
              }
            }
            // A reply with no complete fact and no closed list (empty, tag-free, or
            // cut off) is a failed merge, so the watermark stays and the next run
            // retries this batch. A closed <facts></facts> or <facts/> is a merge
            // that found nothing, which the prompt allows. A cut-off reply with
            // complete facts keeps them and advances: retrying a batch that always
            // truncates would stall the tier on it.
            const closed = /<\/facts>|<facts\s*\/>/.test(response);
            if (parsedFacts === 0 && !closed) {
              throw new Error(NO_FACTS_ERROR);
            }
            if (!closed) {
              logger.warn("Semantic merge reply has no closing </facts>; kept its complete facts", {
                parsedFacts,
              });
            }
            await advanceSemanticCursor(kv, recentSummaries[recentSummaries.length - 1]!);
            // Best-effort: a stale count names a head behind the cursor, so it
            // can never match a future batch.
            await kv.delete(KV.config, SEMANTIC_FAILED_BATCH_KEY).catch(() => {});
            const evicted = await evictPastCap(kv, existingSemantic);
            if (evicted.length > 0) {
              await recordAudit(kv, "delete", "mem::consolidate-pipeline", evicted, {
                resource: "semantic",
                reason: "semantic row cap",
                cap: SEMANTIC_MAX_ROWS,
              });
            }
            results.semantic = {
              newFacts,
              totalSummaries: summaries.length,
              consumedSummaries: recentSummaries.length,
              evicted: evicted.length,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Semantic consolidation failed", { error: msg });
            results.semantic = { error: msg };
            if (isSemanticContentFailure(err)) {
              await recordSemanticFailure(kv, recentSummaries).catch((countErr) =>
                logger.warn("Could not record the semantic batch failure", {
                  error: countErr instanceof Error ? countErr.message : String(countErr),
                }),
              );
            }
          }
        } else {
          results.semantic = {
            skipped: true,
            reason: "fewer than 5 summaries",
          };
        }
      }

      if (tier === "all" || tier === "reflect") {
        try {
          const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
            maxClusters: 10,
            project: data?.project,
          } });
          results.reflect = reflectResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Reflect tier failed", { error: msg });
          results.reflect = { error: msg };
        }
      }

      if (tier === "all" || tier === "procedural") {
        const memories = await kv.list<Memory>(KV.memories);
        const patterns = memories
          .filter((m) => m.isLatest && m.type === "pattern")
          .map((m) => ({
            content: m.content,
            frequency: m.sessionIds.length || 1,
          }))
          .filter((p) => p.frequency >= 2);

        if (patterns.length >= 2) {
          const prompt = buildProceduralExtractionPrompt(patterns);

          try {
            const response = await provider.summarize(
              PROCEDURAL_EXTRACTION_SYSTEM,
              prompt,
            );

            const procRegex =
              /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
            let match;
            let newProcs = 0;
            const now = new Date().toISOString();
            const existingProcs = await kv.list<ProceduralMemory>(
              KV.procedural,
            );

            while ((match = procRegex.exec(response)) !== null) {
              const name = match[1];
              const trigger = match[2];
              const stepsBlock = match[3];
              const steps: string[] = [];

              const stepRegex = /<step>([^<]+)<\/step>/g;
              let stepMatch;
              while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
                steps.push(stepMatch[1].trim());
              }

              const existing = existingProcs.find(
                (p) => p.name.toLowerCase() === name.toLowerCase(),
              );
              if (existing) {
                existing.frequency++;
                existing.updatedAt = now;
                existing.strength = Math.min(1, existing.strength + 0.1);
                await kv.set(KV.procedural, existing.id, existing);
              } else {
                const proc: ProceduralMemory = {
                  id: generateId("proc"),
                  name,
                  steps,
                  triggerCondition: trigger,
                  frequency: 1,
                  sourceSessionIds: [],
                  strength: 0.5,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.procedural, proc.id, proc);
                newProcs++;
              }
            }
            results.procedural = {
              newProcedures: newProcs,
              patternsAnalyzed: patterns.length,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = { error: msg };
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      if (tier === "all" || tier === "decay") {
        const semantic = await kv.list<SemanticMemory>(KV.semantic);
        const procedural = await kv.list<ProceduralMemory>(KV.procedural);

        const semanticResult = await decayAndWriteChanged(
          kv,
          KV.semantic,
          semantic,
          decayDays,
        );
        const proceduralResult = await decayAndWriteChanged(
          kv,
          KV.procedural,
          procedural,
          decayDays,
        );

        results.decay = {
          semantic: semanticResult,
          procedural: proceduralResult,
        };
      }

      if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        results,
      });

      await kv
        .set(KV.config, CONSOLIDATION_LAST_RUN_KEY, { at: new Date().toISOString(), tier, results })
        .catch(() => {});

      logger.info("Consolidation pipeline complete", { tier, results });
      return { success: true, results };
    },
  );
}
