import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { GraphEdge, GraphNode, Memory } from "../types.js";
import { recordAudit } from "./audit.js";
import { graphWriter } from "./graph.js";
import { readObsIndex } from "../state/graph-store.js";
import { logger } from "../logger.js";

export function registerCascadeFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::cascade-update",
    async (data: { supersededMemoryId: string }) => {
      if (!data.supersededMemoryId || typeof data.supersededMemoryId !== "string") {
        return { success: false, error: "supersededMemoryId is required" };
      }

      const superseded = await kv.get<Memory>(KV.memories, data.supersededMemoryId);
      if (!superseded) {
        return { success: false, error: "superseded memory not found" };
      }

      let flaggedNodes = 0;
      let flaggedEdges = 0;
      let flaggedMemories = 0;
      let graphUnindexed = false;

      const obsIds = new Set(superseded.sourceObservationIds || []);

      if (obsIds.size > 0) {
        // This used to enumerate both graph scopes and resolve every row's
        // provenance to test membership -- the whole corpus read to find a
        // handful of rows, refused outright on a graph over the guard. The
        // inverted index answers in the direction this actually asks, so the
        // read is one kv.get per superseded observation plus one per row it
        // names. It is also what keeps the flagging exact once U2 caps
        // sourceBatchIds (KTD5): the cap drops old batch ids, membership
        // testing would silently stop matching, and obs-index does not care
        // which provenance shape the row carries because it never reads it.
        const nodeIds = new Set<string>();
        const edgeIds = new Set<string>();
        for (const obsId of obsIds) {
          const entry = await readObsIndex(kv, obsId);
          for (const id of entry.nodes) nodeIds.add(id);
          for (const id of entry.edges) edgeIds.add(id);
        }

        if (nodeIds.size === 0 && edgeIds.size === 0) {
          // A store whose rows predate the index flags nothing here, and that
          // has to be loud rather than a silent zero. mem::graph-index-backfill
          // is what closes it; until it runs, this line is the signal.
          graphUnindexed = true;
          logger.warn("Cascade found no obs-index entries for the superseded memory", {
            supersededMemoryId: data.supersededMemoryId,
            observationIds: obsIds.size,
            remedy:
              "run mem::graph-index-backfill, or GRAPH_INDEX_BACKFILL=true on boot",
          });
        }

        const now = new Date().toISOString();
        const write = graphWriter(kv);
        // guardedSet refuses an oversized value and returns rather than throws,
        // so counting a flag before checking the result would report a row as
        // stale while it is still live. Not reachable at today's row sizes --
        // production's largest node is 572,956 B against a 15 MiB limit -- but
        // the row scopes are what U2 exists to shrink, which is a statement
        // about how they grow.
        const refused = (result: unknown) =>
          typeof result === "object" &&
          result !== null &&
          (result as { oversized?: unknown }).oversized === true;
        let flagsRefused = 0;

        for (const nodeId of nodeIds) {
          const node = await kv
            .get<GraphNode>(KV.graphNodes, nodeId)
            .catch(() => null);
          if (!node || node.stale) continue;
          node.stale = true;
          node.updatedAt = now;
          if (refused(await write(KV.graphNodes, node.id, node))) {
            flagsRefused++;
            continue;
          }
          await recordAudit(kv, "consolidate", "mem::cascade-update", [node.id], {
            resourceType: "GraphNode",
            change: "marked stale from superseded memory",
            supersededMemoryId: data.supersededMemoryId,
          });
          flaggedNodes++;
        }

        for (const edgeId of edgeIds) {
          const edge = await kv
            .get<GraphEdge>(KV.graphEdges, edgeId)
            .catch(() => null);
          if (!edge || edge.stale) continue;
          edge.stale = true;
          if (refused(await write(KV.graphEdges, edge.id, edge))) {
            flagsRefused++;
            continue;
          }
          await recordAudit(kv, "consolidate", "mem::cascade-update", [edge.id], {
            resourceType: "GraphEdge",
            change: "marked stale from superseded memory",
            supersededMemoryId: data.supersededMemoryId,
          });
          flaggedEdges++;
        }

        if (flagsRefused > 0) {
          logger.warn("Cascade could not write every stale flag", {
            supersededMemoryId: data.supersededMemoryId,
            refused: flagsRefused,
          });
        }
      }

      const supersededConcepts = new Set(
        (superseded.concepts ?? []).map((c) => c.toLowerCase()),
      );
      if (supersededConcepts.size >= 2) {
        const allMemories = await kv.list<Memory>(KV.memories);
        for (const mem of allMemories) {
          if (mem.id === data.supersededMemoryId) continue;
          if (!mem.isLatest) continue;

          const sharedCount = (mem.concepts ?? []).filter((c) =>
            supersededConcepts.has(c.toLowerCase()),
          ).length;
          if (sharedCount >= 2) {
            flaggedMemories++;
          }
        }
      }

      return {
        success: true,
        flagged: {
          nodes: flaggedNodes,
          edges: flaggedEdges,
          siblingMemories: flaggedMemories,
        },
        total: flaggedNodes + flaggedEdges + flaggedMemories,
        ...(graphUnindexed
          ? {
              warning:
                "no mem:graph:obs-index entries for this memory's observations; " +
                "graph rows not flagged. Run mem::graph-index-backfill.",
            }
          : {}),
      };
    },
  );
}
