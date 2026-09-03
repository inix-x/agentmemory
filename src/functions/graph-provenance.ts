import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { GraphBatch, GraphEdge, GraphNode } from "../types.js";
import { logger } from "../logger.js";

// The one place a graph row's observation ids come from. A row written in
// legacy mode carries them inline; a row written in batch mode carries batch
// ids and the observation ids live one kv.get away. Readers must not care which,
// and must keep not caring after a flag flip back to legacy, because rows
// written in batch mode stay on disk either way (R10).
//
// Order is preserved and matches what legacy mode would emit: inline ids first,
// then each batch's ids in batch order. Retrieval scores by first-seen, so the
// order is part of the contract, not a nicety.

type ProvenanceRow = Pick<GraphNode, "sourceObservationIds" | "sourceBatchIds">;

// A batch id that resolves to nothing is logged once per process, not once per
// row: a missing batch row repeats across every node and edge it stamped, and
// the interesting fact is that it is missing, not how many rows noticed.
const missingBatchWarned = new Set<string>();

export function batchCache(): Map<string, GraphBatch | null> {
  return new Map();
}

async function loadBatch(
  kv: StateKV,
  batchId: string,
  cache: Map<string, GraphBatch | null>,
): Promise<GraphBatch | null> {
  if (cache.has(batchId)) return cache.get(batchId)!;
  let batch: GraphBatch | null = null;
  try {
    batch = await kv.get<GraphBatch>(KV.graphBatches, batchId);
  } catch (err) {
    batch = null;
    if (!missingBatchWarned.has(batchId)) {
      missingBatchWarned.add(batchId);
      logger.warn("Graph batch read failed", {
        batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!batch && !missingBatchWarned.has(batchId)) {
    missingBatchWarned.add(batchId);
    logger.warn("Graph batch row missing; its rows resolve to no observations", {
      batchId,
    });
  }
  cache.set(batchId, batch);
  return batch;
}

export async function resolveObservationIds(
  kv: StateKV,
  row: ProvenanceRow,
  cache: Map<string, GraphBatch | null> = batchCache(),
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const id of row.sourceObservationIds ?? []) push(id);
  for (const batchId of row.sourceBatchIds ?? []) {
    const batch = await loadBatch(kv, batchId, cache);
    for (const id of batch?.observationIds ?? []) push(id);
  }
  return out;
}

// Materialise provenance for a whole graph in one pass so callers that iterate
// nodes and edges together -- retrieval, cascade -- pay one kv.get per distinct
// batch rather than one per row.
export async function resolveGraphObservationIds(
  kv: StateKV,
  rows: Array<GraphNode | GraphEdge>,
): Promise<Map<string, string[]>> {
  const cache = batchCache();
  const resolved = new Map<string, string[]>();
  for (const row of rows) {
    resolved.set(row.id, await resolveObservationIds(kv, row, cache));
  }
  return resolved;
}

export function resetProvenanceWarningsForTests(): void {
  missingBatchWarned.clear();
}
