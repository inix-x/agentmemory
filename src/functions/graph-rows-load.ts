import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { logger } from "../logger.js";
import { graphWriter } from "./graph.js";
import {
  putGraphEdgeRows,
  putGraphNodeRow,
  type GraphObsIndexEntry,
} from "../state/graph-store.js";
import type { GraphBatch, GraphEdge, GraphNode } from "../types.js";

// U2 step 4, and the other half of GRAPH_ROWS_REWRITE_AT_BOOT. The entrypoint
// retired the six originals before the engine started; this puts the rewritten
// rows back through the verbatim row importer path, one kv.set per row, so the
// engine produces the .bin in its own format (KTD3).
//
// It reads what scripts/graph-rewrite/rewrite.py emitted:
//   <dir>/nodes.rows.json        [{ key, value }]
//   <dir>/edges.rows.json        [{ key, value }]
//   <dir>/<scope>.batches.json   [GraphBatch]
//   <dir>/<scope>.obs-index.json [{ key, value }]

type Stream<T> = Array<{ key: string; value: T }>;

function readStream<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
}

function readOptional<T>(dir: string, name: string, fallback: T): T {
  try {
    return readStream<T>(dir, name);
  } catch {
    return fallback;
  }
}

export function registerGraphRowsLoadFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::graph-rows-load",
    async (data?: { dir?: string }) => {
      const dir = data?.dir;
      if (!dir) {
        return { success: false, error: "dir is required" };
      }
      const started = Date.now();
      const write = graphWriter(kv);
      const stats = {
        nodes: 0,
        edges: 0,
        batches: 0,
        obsIndex: 0,
        nameIndex: 0,
        edgeKeys: 0,
        degrees: 0,
      };

      let nodeRows: Stream<GraphNode>;
      let edgeRows: Stream<GraphEdge>;
      try {
        // Both streams are required, not one required and one optional. This
        // runs after the entrypoint retired the six originals, so a run that
        // loaded 37,039 nodes and no edges would report success on a store with
        // every degree at zero and no traversable graph, with nothing left on
        // disk to retry from. The emitter always writes both files; a missing
        // one means a truncated or wrong directory, and that is a refusal.
        nodeRows = readStream<Stream<GraphNode>>(dir, "nodes.rows.json");
        edgeRows = readStream<Stream<GraphEdge>>(dir, "edges.rows.json");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Graph rows load failed to read its input", { dir, message });
        return { success: false, error: message };
      }

      // Rows first, then the adjacency in one pass. putGraphNodeRow writes the
      // row and its catalog entry together; putGraphEdgeRows writes adjacency
      // only, because two edges sharing an endpoint inside one concurrent chunk
      // would each read the pre-merge stub list and the second write would lose
      // the first's stub (the reason export-import coalesces it the same way).
      for (const { value } of nodeRows) {
        await putGraphNodeRow(value, write);
        stats.nodes++;
      }
      for (const { key, value } of edgeRows) {
        await write(KV.graphEdges, key, value);
        stats.edges++;
      }
      await putGraphEdgeRows(
        kv,
        edgeRows.map((r) => r.value),
        write,
      );

      // The two scopes emit obs-index separately and an observation is cited by
      // both, so the streams are merged before they are written. Writing them in
      // sequence would have the edge stream's entry, whose nodes list is empty,
      // overwrite the node stream's.
      const obsIndex = new Map<string, GraphObsIndexEntry>();
      for (const scope of ["nodes", "edges"] as const) {
        for (const batch of readOptional<GraphBatch[]>(
          dir,
          `${scope}.batches.json`,
          [],
        )) {
          await write(KV.graphBatches, batch.id, batch);
          stats.batches++;
        }
        for (const { key, value } of readOptional<Stream<GraphObsIndexEntry>>(
          dir,
          `${scope}.obs-index.json`,
          [],
        )) {
          const merged = obsIndex.get(key) ?? { nodes: [], edges: [] };
          obsIndex.set(key, {
            nodes: [...new Set([...merged.nodes, ...value.nodes])],
            edges: [...new Set([...merged.edges, ...value.edges])],
          });
        }
      }
      for (const [key, value] of obsIndex) {
        await write(KV.graphObsIndex, key, value);
        stats.obsIndex++;
      }

      // The three targeted-lookup indexes are derived, not carried: recompute
      // them from the kept rows in the same load, or a post-swap extract's
      // name-index lookup misses and it writes a duplicate row for every entity
      // the rewrite just kept.
      for (const { value } of nodeRows) {
        await write(KV.graphNameIndex, `${value.type}|${value.name}`, value.id);
        stats.nameIndex++;
      }
      const degrees = new Map<string, number>();
      for (const { value } of edgeRows) {
        await write(
          KV.graphEdgeKey,
          `${value.sourceNodeId}|${value.targetNodeId}|${value.type}`,
          value.id,
        );
        stats.edgeKeys++;
        degrees.set(value.sourceNodeId, (degrees.get(value.sourceNodeId) ?? 0) + 1);
        degrees.set(value.targetNodeId, (degrees.get(value.targetNodeId) ?? 0) + 1);
      }
      for (const { value } of nodeRows) {
        await write(KV.graphNodeDegree, value.id, degrees.get(value.id) ?? 0);
        stats.degrees++;
      }

      const tookMs = Date.now() - started;
      logger.info("Graph rows loaded from rewrite", { dir, ...stats, tookMs });
      return { success: true, ...stats, tookMs };
    },
  );
}
