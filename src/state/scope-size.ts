import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
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

  const rows = await kv.list<T>(scope);

  // Measure what it actually cost so the next call is guarded even when
  // this one was a cold miss.
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
