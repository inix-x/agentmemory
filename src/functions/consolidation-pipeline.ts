import type { ISdk } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
} from "../types.js";
import {
  CONSOLIDATION_MARKER_KEY,
  KV,
  generateId,
} from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import { getConsolidationDecayDays, isConsolidationEnabled } from "../config.js";
import { logger } from "../logger.js";

function applyDecay(
  items: Array<{
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
  }>,
  decayDays: number,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const daysSince =
      (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
    }
  }
}

/** Fixed key holding a pointer to the in-flight run, if there is one. */
const RUN_POINTER_KEY = "current";


// A run whose worker dies mid-invocation never finalizes its row, and must not
// hold the exclusion for good. The next trigger past this age stamps that row
// interrupted and starts. Sized well above the observed run length (~6 minutes
// in the 2026-09-04 production reading) so a slow but living run is never
// displaced by a competing one.
const RUN_EXCLUSION_LIFETIME_MS = 15 * 60 * 1000;

// The run scope is a ring. Reliability work must not hand this service another
// scope that grows one row per Stop hook forever.
const MAX_RUN_ROWS = 50;

export type ConsolidationRunStatus = "running" | "completed" | "interrupted";

export type ConsolidationRunRecord = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: ConsolidationRunStatus;
  tier: string;
  triggersDuringRun: number;
  results?: Record<string, unknown>;
};

type RunPointer = { runId: string; startedAt: string };

/**
 * Tags a tier outcome with an explicit status, so an operator can tell a tier
 * that declined to run from one that threw. Collapsing those two into one
 * value is what made the graph scope guard self-perpetuating.
 */
function withStatus(
  status: "ok" | "skipped" | "error",
  value: unknown,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { status, ...(value as Record<string, unknown>) }
    : { status, result: value };
}

/**
 * Counts one turned-away trigger against a row this process does not own, which
 * only happens on the durable-pointer path after a worker death.
 */
async function countTurnedAwayTrigger(kv: StateKV, runId: string): Promise<void> {
  const row = await kv
    .get<ConsolidationRunRecord>(KV.consolidationRuns, runId)
    .catch(() => null);
  if (!row) return;
  await kv
    .set<ConsolidationRunRecord>(KV.consolidationRuns, runId, {
      ...row,
      triggersDuringRun: (row.triggersDuringRun ?? 0) + 1,
    })
    .catch(() => undefined);
}

/**
 * Records how long a tier took, onto the outcome it already produced. Stamped
 * after the block rather than at each assignment site, so the timing cannot
 * disagree with itself across a tier's success, skip, and error paths.
 */
function stampMs(
  results: Record<string, unknown>,
  key: string,
  startedMs: number,
): void {
  const entry = results[key];
  if (entry && typeof entry === "object") {
    results[key] = {
      ...(entry as Record<string, unknown>),
      ms: Date.now() - startedMs,
    };
  }
}

/**
 * Reduces a run's per-tier outcomes to one status word each.
 *
 * The audit row is what memory_audit and GET /agentmemory/audit expose, and it
 * is also what an operator reads to answer "did the last run finish, and what
 * did it skip". It must stay small: audit partitions refuse enumeration past
 * 15 MiB (src/functions/audit.ts), and the legacy scope is already over that
 * ceiling in production. Writing per-tier timings, byte counts, and row counts
 * onto every row would push the partition toward the same wall, and take the
 * surface the answer is read from down with it.
 *
 * So the audit row carries the shape and the run id; the run row carries the
 * numbers. Bounded by the tier count rather than by a byte budget, which is a
 * cap that cannot be exceeded by adding a measurement later.
 */
function auditOutcomes(results: Record<string, unknown>): Record<string, string> {
  const outcomes: Record<string, string> = {};
  for (const [tier, outcome] of Object.entries(results)) {
    const status =
      outcome && typeof outcome === "object"
        ? (outcome as { status?: unknown }).status
        : undefined;
    outcomes[tier] = typeof status === "string" ? status : "unknown";
  }
  return outcomes;
}

async function finalizeRun(
  kv: StateKV,
  runId: string,
  status: ConsolidationRunStatus,
  results: Record<string, unknown>,
  triggersDuringRun?: number,
): Promise<void> {
  const row = await kv
    .get<ConsolidationRunRecord>(KV.consolidationRuns, runId)
    .catch(() => null);
  if (!row) return;
  await kv
    .set<ConsolidationRunRecord>(KV.consolidationRuns, runId, {
      ...row,
      status,
      finishedAt: new Date().toISOString(),
      results,
      ...(triggersDuringRun === undefined ? {} : { triggersDuringRun }),
    })
    .catch(() => undefined);
}

async function trimRunRows(kv: StateKV): Promise<void> {
  const rows = await kv
    .list<ConsolidationRunRecord>(KV.consolidationRuns)
    .catch(() => [] as ConsolidationRunRecord[]);
  // The pointer lives in this scope too and carries no status, which is what
  // separates it from a run row here.
  const runs = rows.filter(
    (r) => r && typeof r.status === "string" && typeof r.runId === "string",
  );
  if (runs.length <= MAX_RUN_ROWS) return;
  runs.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  for (const stale of runs.slice(MAX_RUN_ROWS)) {
    await kv.delete(KV.consolidationRuns, stale.runId).catch(() => undefined);
  }
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  // One worker serves every entry point that can start a run — the Stop-hook
  // trigger, the interval timer, eviction recovery, the POST route, and the MCP
  // tool — so a single in-process flag excludes all five. Mirrors the session
  // sweep's guard (src/functions/session-sweep.ts).
  let inFlight = false;
  // Triggers the current run turned away, held in memory and written once at
  // finalize. Counting them against the row as they arrive costs a get plus a
  // set per trigger, on the one worker this work exists to unblock, and misses
  // every trigger landing before the row exists — in a burst, most of them.
  let turnedAway = 0;

  sdk.registerFunction("mem::consolidate-pipeline",
    async (data?: { tier?: string; force?: boolean; project?: string }) => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY / OPENAI_BASE_URL / AGENTMEMORY_PROVIDER=agent-sdk)" };
      }

      // The exclusion sits after the enabled gate on purpose: force is meant to
      // bypass the gate, never the exclusion.
      if (inFlight) {
        turnedAway++;
        return {
          success: true,
          skipped: true,
          reason: "A consolidation run is already in flight",
        };
      }
      // Claim the guard before the first await. Two invocations arriving in one
      // tick both clear a check that yields before it claims, and a guard that
      // yields first is not a guard.
      inFlight = true;
      turnedAway = 0;

      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};
      let runId: string | null = null;
      let completed = false;
      try {
        const pointer = await kv
          .get<RunPointer>(KV.consolidationRuns, RUN_POINTER_KEY)
          .catch(() => null);
        if (pointer?.runId) {
          const age = Date.now() - new Date(pointer.startedAt).getTime();
          // An unparseable startedAt yields NaN, and NaN < lifetime is false,
          // so it falls through to the release below. Releasing a run we cannot
          // date is the safe direction; holding the exclusion on one is not.
          if (age < RUN_EXCLUSION_LIFETIME_MS) {
            await countTurnedAwayTrigger(kv, pointer.runId);
            return {
              success: true,
              skipped: true,
              reason: "A consolidation run is already in flight",
            };
          }
          await finalizeRun(kv, pointer.runId, "interrupted", {
            reason: "Run exceeded its exclusion lifetime without finalizing",
          });
        }

        runId = generateId("crun");
        const startedAt = new Date().toISOString();
        await kv.set<ConsolidationRunRecord>(KV.consolidationRuns, runId, {
          runId,
          startedAt,
          status: "running",
          tier,
          triggersDuringRun: 0,
        });
        await kv.set<RunPointer>(KV.consolidationRuns, RUN_POINTER_KEY, {
          runId,
          startedAt,
        });

        const semanticStartedMs = Date.now();
        if (tier === "all" || tier === "semantic") {
          const summaries = await kv.list<SessionSummary>(KV.summaries);
          const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);

          if (summaries.length >= 5) {
            const recentSummaries = summaries
              .sort(
                (a, b) =>
                  new Date(b.createdAt).getTime() -
                  new Date(a.createdAt).getTime(),
              )
              .slice(0, 20);

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
              const now = new Date().toISOString();

              while ((match = factRegex.exec(response)) !== null) {
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
                }
              }
              results.semantic = withStatus("ok", {
                newFacts,
                totalSummaries: summaries.length,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error("Semantic consolidation failed", { error: msg });
              results.semantic = withStatus("error", { error: msg });
            }
          } else {
            results.semantic = withStatus("skipped", {
              skipped: true,
              reason: "fewer than 5 summaries",
            });
          }
        }

        stampMs(results, "semantic", semanticStartedMs);
        const reflectStartedMs = Date.now();

        if (tier === "all" || tier === "reflect") {
          try {
            const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
              maxClusters: 10,
              project: data?.project,
              // Stamped here, read at the far side, so the run record can
              // separate reflect waiting for the worker from reflect working.
              triggeredAtMs: Date.now(),
            } });
            results.reflect = withStatus("ok", reflectResult);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("Reflect tier failed", { error: msg });
            results.reflect = withStatus("error", { error: msg });
          }
        }

        stampMs(results, "reflect", reflectStartedMs);
        const proceduralStartedMs = Date.now();

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
              results.procedural = withStatus("ok", {
                newProcedures: newProcs,
                patternsAnalyzed: patterns.length,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error("Procedural extraction failed", { error: msg });
              results.procedural = withStatus("error", { error: msg });
            }
          } else {
            results.procedural = withStatus("skipped", {
              skipped: true,
              reason: "fewer than 2 recurring patterns",
            });
          }
        }

        stampMs(results, "procedural", proceduralStartedMs);
        const decayStartedMs = Date.now();

        if (tier === "all" || tier === "decay") {
          const semantic = await kv.list<SemanticMemory>(KV.semantic);
          applyDecay(semantic, decayDays);
          for (const s of semantic) {
            await kv.set(KV.semantic, s.id, s);
          }

          const procedural = await kv.list<ProceduralMemory>(KV.procedural);
          applyDecay(procedural, decayDays);
          for (const p of procedural) {
            await kv.set(KV.procedural, p.id, p);
          }

          results.decay = withStatus("ok", {
            semantic: semantic.length,
            procedural: procedural.length,
          });
        }

        stampMs(results, "decay", decayStartedMs);

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
          runId,
          outcomes: auditOutcomes(results),
        });

        await finalizeRun(kv, runId, "completed", results, turnedAway);
        completed = true;

        logger.info("Consolidation pipeline complete", { tier, runId, results });
        return { success: true, runId, results };
      } finally {
        // runId is null when the exclusion turned this invocation away before a
        // run began; there is nothing of ours to finalize or clean up then.
        if (runId) {
          // A throw anywhere above leaves the row saying "running", which the
          // next trigger would otherwise honour as a live run for the whole
          // exclusion lifetime. Stamp it here instead, while the process is
          // still alive to tell a crash apart from a worker death.
          if (!completed) {
            await finalizeRun(
              kv,
              runId,
              "interrupted",
              results,
              turnedAway,
            ).catch(() => undefined);
          }
          await kv
            .delete(KV.consolidationRuns, RUN_POINTER_KEY)
            .catch(() => undefined);
          await trimRunRows(kv);
          // Stamp the cooldown from the END of the run. Stamped at check time,
          // as it was, a run longer than the cooldown leaves a marker already
          // stale by the time it finishes, so the next run starts immediately
          // and the cooldown spaces nothing. An interrupted run stamps too: the
          // worker paid for the work either way.
          await kv
            .set(KV.config, CONSOLIDATION_MARKER_KEY, { at: Date.now() })
            .catch(() => undefined);
        }
        inFlight = false;
      }
    },
  );
}
