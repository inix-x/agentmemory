import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { logger } from "../logger.js";
import { listGraphScopes, graphWriter } from "./graph.js";
import {
  flushIndexDelta,
  newIndexDelta,
  recordEdgeAdjacency,
  recordNodeName,
  recordRowObservations,
} from "../state/graph-store.js";

// U3. persistGraphDelta indexes every row it writes from here on, so a store
// that keeps taking extracts converges on its own. A store that already holds
// rows does not: they were written before the index existed, and until they are
// indexed the search path finds nothing for them and mem::cascade-update flags
// nothing for their observations.
//
// This is the one-time catch-up. It is deliberately not wired into any hot
// path: it enumerates, which is the thing the rest of U3 exists to stop doing.

const CURSOR_KEY = "graph:index-backfill";
const PROGRESS_LOG_EVERY = 1_000;

// Rows per invocation. The engine's invocation deadline is the real bound; this
// keeps one run well inside it and hands the caller a resume point.
const DEFAULT_MAX_ROWS = 5_000;

// The obs-index ceiling, and the one number in this file worth arguing about.
// KTD2 rejects transposing sourceObservationIds as the index's construction:
// the reachable corpus holds 72,972,070 pairs, about 1.9 GiB, because 688 rows
// cite each of 106,025 observations on average. Going forward the index is built from the
// extraction event and is linear in observations instead. But a row already on
// disk has no event behind it, and its inline array is the only provenance
// there is, so the catch-up transposes what it can and stops at a ceiling
// rather than reproducing the 1.9 GiB shape.
//
// Partial is safe here because cascade asks per observation: an obsId either
// has an entry, and the answer is exact, or it does not, and cascade says so.
const DEFAULT_MAX_PAIRS = 2_000_000;

export type GraphIndexBackfillCursor = {
  nodesDone: number;
  edgesDone: number;
  pairs: number;
  complete: boolean;
  pairCeilingHit: boolean;
  updatedAt: string;
};

const emptyCursor = (): GraphIndexBackfillCursor => ({
  nodesDone: 0,
  edgesDone: 0,
  pairs: 0,
  complete: false,
  pairCeilingHit: false,
  updatedAt: new Date(0).toISOString(),
});

export function registerGraphIndexBackfillFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::graph-index-backfill",
    async (data?: { maxRows?: number; maxPairs?: number; restart?: boolean }) => {
      const started = Date.now();
      const maxRows =
        typeof data?.maxRows === "number" && data.maxRows > 0
          ? data.maxRows
          : DEFAULT_MAX_ROWS;
      const maxPairs =
        typeof data?.maxPairs === "number" && data.maxPairs >= 0
          ? data.maxPairs
          : DEFAULT_MAX_PAIRS;

      const cursor = data?.restart
        ? emptyCursor()
        : (await kv
            .get<GraphIndexBackfillCursor>(KV.config, CURSOR_KEY)
            .catch(() => null)) ?? emptyCursor();

      if (cursor.complete && !data?.restart) {
        return { success: true, alreadyComplete: true, cursor };
      }

      // listGraphScopes, not listBounded. Both refuse an over-budget scope, but
      // listBounded records an unfinished-attempt marker keyed by scope, so a
      // backfill that dies mid-read would latch mem::export and mem::reflect
      // off the same scopes. listGraphScopes decides from the snapshot instead
      // and leaves no marker behind.
      const graph = await listGraphScopes(kv, "mem::graph-index-backfill");
      if (!graph.enumerated) {
        logger.warn("Graph index backfill refused: enumeration not permitted", {
          remedy:
            "the corpus is over the enumeration budget; run this after the " +
            "U2 rebuild, or on a store small enough for the guard to allow",
        });
        return {
          success: false,
          error: "graph scope enumeration refused; nothing was indexed",
          cursor,
        };
      }

      const write = graphWriter(kv);
      let processed = 0;
      let pairs = cursor.pairs;
      let pairCeilingHit = cursor.pairCeilingHit;
      let delta = newIndexDelta();

      const flush = async () => {
        await flushIndexDelta(kv, delta, write);
        delta = newIndexDelta();
      };

      // Rows are indexed in list order and the cursor counts how many of each
      // scope are done, so a run that dies re-reads but does not rewrite. Every
      // write is a merge, so a rerun that does overlap is a no-op.
      for (let i = cursor.nodesDone; i < graph.nodes.length; i++) {
        if (processed >= maxRows) break;
        const node = graph.nodes[i]!;
        recordNodeName(delta, node);
        const obsIds = node.sourceObservationIds ?? [];
        if (!pairCeilingHit && pairs + obsIds.length > maxPairs) {
          pairCeilingHit = true;
        }
        if (!pairCeilingHit) {
          recordRowObservations(delta, obsIds, node.id, "node");
          pairs += obsIds.length;
        }
        cursor.nodesDone = i + 1;
        processed++;
        if (processed % PROGRESS_LOG_EVERY === 0) {
          await flush();
          logger.info("Graph index backfill progress", {
            nodesDone: cursor.nodesDone,
            edgesDone: cursor.edgesDone,
            totalNodes: graph.nodes.length,
            totalEdges: graph.edges.length,
            pairs,
            pairCeilingHit,
          });
        }
      }

      for (let i = cursor.edgesDone; i < graph.edges.length; i++) {
        if (processed >= maxRows) break;
        const edge = graph.edges[i]!;
        recordEdgeAdjacency(delta, edge);
        const obsIds = edge.sourceObservationIds ?? [];
        if (!pairCeilingHit && pairs + obsIds.length > maxPairs) {
          pairCeilingHit = true;
        }
        if (!pairCeilingHit) {
          recordRowObservations(delta, obsIds, edge.id, "edge");
          pairs += obsIds.length;
        }
        cursor.edgesDone = i + 1;
        processed++;
        if (processed % PROGRESS_LOG_EVERY === 0) {
          await flush();
          logger.info("Graph index backfill progress", {
            nodesDone: cursor.nodesDone,
            edgesDone: cursor.edgesDone,
            totalNodes: graph.nodes.length,
            totalEdges: graph.edges.length,
            pairs,
            pairCeilingHit,
          });
        }
      }

      await flush();

      cursor.pairs = pairs;
      cursor.pairCeilingHit = pairCeilingHit;
      cursor.complete =
        cursor.nodesDone >= graph.nodes.length &&
        cursor.edgesDone >= graph.edges.length;
      cursor.updatedAt = new Date().toISOString();
      await kv.set(KV.config, CURSOR_KEY, cursor);

      const tookMs = Date.now() - started;
      logger.info("Graph index backfill run finished", {
        processed,
        nodesDone: cursor.nodesDone,
        edgesDone: cursor.edgesDone,
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
        pairs,
        pairCeilingHit,
        complete: cursor.complete,
        tookMs,
      });

      return { success: true, processed, cursor, tookMs };
    },
  );
}
