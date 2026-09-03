import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Memory } from "../types.js";
import { recordAudit } from "./audit.js";
import { listGraphScopes } from "./graph.js";
import { resolveGraphObservationIds } from "./graph-provenance.js";
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
      let graphSkipped = false;

      const obsIds = new Set(superseded.sourceObservationIds || []);

      if (obsIds.size > 0) {
        // This used to kv.list both graph scopes directly, bypassing the
        // enumeration guard every other graph reader goes through. On a
        // refused graph that is the unbounded read that gets the worker
        // declared dead; the guard returns empty and says so instead.
        const graph = await listGraphScopes(kv, "mem::cascade-update");
        if (!graph.enumerated) {
          graphSkipped = true;
          logger.warn("Cascade skipped graph flagging: enumeration refused", {
            supersededMemoryId: data.supersededMemoryId,
          });
        } else {
          const now = new Date().toISOString();
          // Provenance resolved across both shapes, so a row that carries a
          // batch id flags exactly when the legacy array would have (R10).
          const provenance = await resolveGraphObservationIds(kv, [
            ...graph.nodes,
            ...graph.edges,
          ]);
          const overlaps = (rowId: string) =>
            (provenance.get(rowId) ?? []).some((id) => obsIds.has(id));

          for (const node of graph.nodes) {
            if (node.stale) continue;
            if (overlaps(node.id)) {
              node.stale = true;
              node.updatedAt = now;
              await kv.set(KV.graphNodes, node.id, node);
              await recordAudit(kv, "consolidate", "mem::cascade-update", [node.id], {
                resourceType: "GraphNode",
                change: "marked stale from superseded memory",
                supersededMemoryId: data.supersededMemoryId,
              });
              flaggedNodes++;
            }
          }

          for (const edge of graph.edges) {
            if (edge.stale) continue;
            if (overlaps(edge.id)) {
              edge.stale = true;
              await kv.set(KV.graphEdges, edge.id, edge);
              await recordAudit(kv, "consolidate", "mem::cascade-update", [edge.id], {
                resourceType: "GraphEdge",
                change: "marked stale from superseded memory",
                supersededMemoryId: data.supersededMemoryId,
              });
              flaggedEdges++;
            }
          }
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
        ...(graphSkipped ? { warning: "graph enumeration refused; graph rows not flagged" } : {}),
      };
    },
  );
}
