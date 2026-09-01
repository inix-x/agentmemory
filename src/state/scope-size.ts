import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { logger } from "../logger.js";
import {
  SAFE_PAYLOAD_BYTES,
  oversizedPayloadError,
  payloadByteLength,
  type OversizedPayload,
} from "./frame-guard.js";

// #814 established the mechanism for graph scopes: a kv.list whose result
// is too big to JSON.parse blocks the worker's event loop, the iii
// heartbeat goes unanswered, the engine declares the worker dead, and
// every in-flight invocation comes back as "Invocation stopped" while new
// requests 404 across the whole route table — including /health.
//
// graph.ts can size itself cheaply because mem:graph:snapshot records
// totalNodes. No other scope has a count, so this records what the last
// successful enumeration actually cost and uses that to decide whether the
// next one is safe. The record lives in KV, so a scope is measured once
// ever rather than once per deploy.
//
// It trails growth by one call: a scope that crosses the ceiling between
// two reads gets one bad call and refuses from then on. Seeding (below)
// covers the scopes already known to be over.
export type ScopeSize = {
  rows: number;
  bytes: number;
  measuredAt: string;
};

// The graph guard budgets 50 MiB, half the 100 MiB `ws` maxPayload, because
// it is defending against the hard RangeError at the frame length header.
// This guard defends against the *parse* stalling the heartbeat, which
// bites far below that: KV.memories measured 38.5 MB in production and
// takes /memories down at a 26.8% rate. Reuse the repo's existing notion
// of a safe payload rather than introduce a fourth number.
export const SAFE_ENUMERATION_BYTES = SAFE_PAYLOAD_BYTES;

// Scopes already measured over the ceiling, so the very first read after
// deploy is guarded instead of taking the worker down to learn what we
// already know. Sizes are from the production measurements recorded in
// docs/plans/2026-08-27-001-fix-frame-kill-emitter-plan.md.
const SEEDED_BYTES: Record<string, number> = {
  [KV.memories]: 38_491_000,
  [KV.graphNodes]: 116_941_396,
  [KV.graphEdges]: 88_869_744,
};

export async function readScopeSize(
  kv: StateKV,
  scope: string,
): Promise<ScopeSize | null> {
  const recorded = await kv
    .get<ScopeSize>(KV.scopeSize, scope)
    .catch(() => null);
  if (recorded && typeof recorded.bytes === "number") return recorded;
  const seeded = SEEDED_BYTES[scope];
  if (typeof seeded === "number") {
    return { rows: 0, bytes: seeded, measuredAt: "seeded" };
  }
  return null;
}

export async function recordScopeSize(
  kv: StateKV,
  scope: string,
  rows: number,
  bytes: number,
): Promise<void> {
  // Never let bookkeeping fail a read that already succeeded.
  await kv
    .set<ScopeSize>(KV.scopeSize, scope, {
      rows,
      bytes,
      measuredAt: new Date().toISOString(),
    })
    .catch(() => undefined);
}

export type ReadAttempt = {
  attempts: number;
  startedAt: string;
};

const attemptKey = (scope: string) => `attempt:${scope}`;

// Tolerate exactly one unfinished read, so a deploy or OOM that happens to
// land mid-enumeration does not blacklist a healthy scope.
const MAX_UNFINISHED_ATTEMPTS = 1;

function unfinishedReadError(
  scope: string,
  attempts: number,
  hint: string,
): OversizedPayload {
  return {
    success: false,
    error:
      `Refusing to enumerate ${scope}: ${attempts} previous read(s) never completed, ` +
      `which is what a payload large enough to stall the worker looks like; ${hint}`,
    oversized: true,
    bytes: 0,
    limitBytes: SAFE_ENUMERATION_BYTES,
  };
}

/**
 * kv.list, but refuses when the last measured size of the scope is over
 * the ceiling. Returns OversizedPayload instead of throwing so callers can
 * answer 413 the way api::mesh-export already does.
 */
export async function listBounded<T>(
  kv: StateKV,
  scope: string,
  hint: string,
  ceilingBytes: number = SAFE_ENUMERATION_BYTES,
): Promise<T[] | OversizedPayload> {
  const known = await readScopeSize(kv, scope);
  if (known && known.bytes > ceilingBytes) {
    return oversizedPayloadError(known.bytes, hint);
  }

  // The size record alone cannot learn about the reads that matter most.
  // A payload big enough to stall the heartbeat gets the worker declared
  // dead mid-invocation, so execution never reaches recordScopeSize below
  // and the scope stays unmeasured — every later call repeats the kill.
  // An unfinished attempt is therefore the signal, and it has to be
  // written BEFORE the read.
  //
  // One unfinished attempt is tolerated so an unrelated restart (deploy,
  // OOM) does not permanently refuse a healthy scope. Two means the read
  // itself is what does not survive.
  const attemptK = attemptKey(scope);
  const prior = await kv.get<ReadAttempt>(KV.scopeSize, attemptK).catch(() => null);
  const unfinished = typeof prior?.attempts === "number" ? prior.attempts : 0;
  if (unfinished > MAX_UNFINISHED_ATTEMPTS) {
    return unfinishedReadError(scope, unfinished, hint);
  }
  await kv
    .set<ReadAttempt>(KV.scopeSize, attemptK, {
      attempts: unfinished + 1,
      startedAt: new Date().toISOString(),
    })
    .catch(() => undefined);

  const rows = await kv.list<T>(scope);

  // Survived, so clear the marker and record what it actually cost.
  await kv.delete(KV.scopeSize, attemptK).catch(() => undefined);
  const bytes = payloadByteLength(rows);
  await recordScopeSize(kv, scope, rows.length, bytes);

  if (bytes > ceilingBytes) {
    // It fit under the previous estimate but does not fit now. Answering
    // 413 here keeps the contract honest, and the record above means the
    // next call refuses before paying the read.
    return oversizedPayloadError(bytes, hint);
  }
  return rows;
}

export function isOversized<T>(
  result: T[] | OversizedPayload,
): result is OversizedPayload {
  return !Array.isArray(result) && (result as OversizedPayload).oversized === true;
}

/**
 * listBounded for background jobs (reflect, retention, export-import).
 *
 * These callers already degrade on failure — most wrap the read in
 * `.catch(() => [])` — so the drop-in shape is an array, not a union. What
 * they must NOT do is take the worker down: an hourly job that enumerates
 * a 38.5 MB scope stalls the event loop, the engine declares the worker
 * dead, and every in-flight HTTP request dies with it. Seven such events
 * cost 53 observations in four hours.
 *
 * Over the ceiling, skip the scope and warn loudly. Skipping degrades one
 * job for one cycle; enumerating takes down the whole service.
 */
export async function listBoundedOrSkip<T>(
  kv: StateKV,
  scope: string,
  caller: string,
): Promise<T[]> {
  const result = await listBounded<T>(
    kv,
    scope,
    `${caller} skipped this scope`,
  ).catch((error) => {
    logger.warn("Background scope read failed", {
      caller,
      scope,
      error: error instanceof Error ? error.message : String(error),
    });
    return [] as T[];
  });
  if (isOversized(result)) {
    logger.warn("Background scope enumeration refused", {
      caller,
      scope,
      bytes: result.bytes,
      limitBytes: result.limitBytes,
      hint: "trim the scope or narrow the job; skipping it this cycle",
    });
    return [] as T[];
  }
  return result;
}
