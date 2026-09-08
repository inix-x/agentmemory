import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { logger } from "../logger.js";
import { buildSnapshotFromArrays, graphWriter, SNAPSHOT_KEY } from "./graph.js";
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
//   <dir>/<scope>.summary.json   { mode, resetAt, ... }, required (KTD-R8)

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
      // KTD-R8. Set when the emit was produced in keep mode, and written onto
      // the snapshot below.
      let carriedResetAt: string | undefined;
      try {
        // Both streams are required, not one required and one optional. This
        // runs after the entrypoint retired the six originals, so a run that
        // loaded 37,039 nodes and no edges would report success on a store with
        // every degree at zero and no traversable graph, with nothing left on
        // disk to retry from. The emitter always writes both files; a missing
        // one means a truncated or wrong directory, and that is a refusal.
        nodeRows = readStream<Stream<GraphNode>>(dir, "nodes.rows.json");
        edgeRows = readStream<Stream<GraphEdge>>(dir, "edges.rows.json");

        // The mode signal is required for the same reason and read here, before
        // anything is written, so a refusal leaves the store untouched. It is
        // NOT optional-with-a-drop-default: treating a missing signal as drop
        // is exactly the silent R7 break KTD-R8 exists to stop, and it would
        // land on a boot with nobody watching. A summary with no mode is a
        // pre-U1 emit, which this rollout does not reuse.
        const summaries = (["nodes", "edges"] as const).map((scope) => {
          const s = readStream<{ mode?: unknown; resetAt?: unknown }>(
            dir,
            `${scope}.summary.json`,
          );
          if (s.mode !== "keep" && s.mode !== "drop") {
            throw new Error(`${scope}.summary.json names no rewrite mode`);
          }
          return s;
        });
        // Two scopes computed against different corpora is the store the
        // missing-stream refusal above exists to stop: keep nodes over drop
        // edges lands 149,732 nodes at degree zero. One forgotten --mode flag
        // produces it, since keep is the default and U2 runs the tool per scope.
        if (summaries[0].mode !== summaries[1].mode) {
          throw new Error("nodes and edges were emitted in different modes");
        }
        // Carry if EITHER scope was emitted in keep mode. The two are always
        // run together, and the asymmetry is deliberate: carrying a stamp that
        // was not needed only holds the enumeration guard shut, while failing
        // to carry one that was widens the writer's merge target to every row.
        const keep = summaries.find((s) => s.mode === "keep");
        if (keep) {
          // The consumers' own predicate (hasOrphanRows, graph.ts:303): an
          // empty string is a string, and it would turn the narrowing off.
          if (
            typeof keep.resetAt !== "string" ||
            !(Date.parse(keep.resetAt) > 0)
          ) {
            throw new Error("keep-mode summary carries no usable resetAt");
          }
          carriedResetAt = keep.resetAt;
        }
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
      //
      // Pre-reset rows get no lookup entry. In keep mode a post-reset node and
      // its pre-reset twin share a name, and the rebuild is last-write-wins in
      // .bin order; the writer nulls any hit that resolves pre-reset
      // (graph.ts:1149-1156), so a twin that won would cost a third row on the
      // next touch. Leaving it out is the outcome the null produces, minus a
      // kv.get. Degrees are unaffected: every edge still counts below.
      const preReset = (row: { createdAt?: unknown }) =>
        carriedResetAt !== undefined &&
        typeof row.createdAt === "string" &&
        row.createdAt < carriedResetAt;
      for (const { value } of nodeRows) {
        if (preReset(value)) continue;
        await write(KV.graphNameIndex, `${value.type}|${value.name}`, value.id);
        stats.nameIndex++;
      }
      const degrees = new Map<string, number>();
      for (const { value } of edgeRows) {
        if (!preReset(value)) {
          await write(
            KV.graphEdgeKey,
            `${value.sourceNodeId}|${value.targetNodeId}|${value.type}`,
            value.id,
          );
          stats.edgeKeys++;
        }
        degrees.set(value.sourceNodeId, (degrees.get(value.sourceNodeId) ?? 0) + 1);
        degrees.set(value.targetNodeId, (degrees.get(value.targetNodeId) ?? 0) + 1);
      }
      for (const { value } of nodeRows) {
        await write(KV.graphNodeDegree, value.id, degrees.get(value.id) ?? 0);
        stats.degrees++;
      }

      // Last, and only once every row above is down. The entrypoint retires
      // mem:graph:snapshot with the other five scopes, so without this the
      // swap leaves no snapshot at all: readSnapshot returns null,
      // checkGraphEnumerable reads totalNodes as null, and it refuses before
      // the byte check for a missing measurement rather than on the corpus
      // size. Built from the rows just loaded, so the counts and the measured
      // per-row bytes describe what is actually on disk, and so a load that
      // threw earlier leaves no snapshot overstating a corpus that never
      // landed.
      //
      // Whether resetAt survives is the emitter's call, not this function's
      // (KTD-R8). In drop mode it does not: every pre-resetAt row was
      // discarded, so the orphan condition the retired snapshot recorded is
      // resolved and carrying the stamp would hold hasOrphanRows() shut for a
      // reason that no longer exists. In keep mode that premise is false --
      // those rows are all still here -- and dropping the stamp would widen
      // the writer's merge target from 1,642 rows to all 151,374, letting it
      // regrow the provenance the rewrite just capped.
      const snapshot = buildSnapshotFromArrays(
        nodeRows.map((r) => r.value),
        edgeRows.map((r) => r.value),
      );
      await write(
        KV.graphSnapshot,
        SNAPSHOT_KEY,
        carriedResetAt ? { ...snapshot, resetAt: carriedResetAt } : snapshot,
      );

      const tookMs = Date.now() - started;
      logger.info("Graph rows loaded from rewrite", {
        dir,
        ...stats,
        totalNodes: snapshot.stats.totalNodes,
        totalEdges: snapshot.stats.totalEdges,
        tookMs,
      });
      return { success: true, ...stats, tookMs };
    },
  );
}
