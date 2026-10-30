import { createGraphIndexState } from "./helpers/graph-index-state.js";
import { initializeGraphIndex } from "../src/state/graph-retrieval-index.js";
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { persistGraphDelta } from "../src/functions/graph.js";
import { MAX_SNAPSHOT_EDGES } from "../src/state/graph-ingestion.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../src/types.js";

const createdAt = "2026-10-30T00:00:00.000Z";

function node(id: string): GraphNode {
  return { id, type: "concept", name: id, properties: {}, sourceObservationIds: [], createdAt };
}

function edge(id: string, weight: number, type: GraphEdge["type"] = "uses"): GraphEdge {
  return { id, type, sourceNodeId: "a", targetNodeId: "b", weight, sourceObservationIds: [], createdAt };
}

// Seed a snapshot whose topEdges is already at the cap, with both endpoints in
// topNodes, so every new a->b edge qualifies for the incremental push. The
// seeded edges live only in the snapshot, so a new edge never dedupes on the
// edge-key index and always arrives as new.
async function fullSnapshot() {
  const { kv } = createGraphIndexState();
  await initializeGraphIndex(kv, { status: "ready" });
  const topNodes = [node("a"), node("b")];
  for (const n of topNodes) {
    await kv.set(KV.graphNodes, n.id, n);
    await kv.set(KV.graphNodeDegree, n.id, MAX_SNAPSHOT_EDGES);
  }
  // Weights 0.1..0.9 with exactly one minimum, seeded mid-array.
  const topEdges = Array.from({ length: MAX_SNAPSHOT_EDGES }, (_, i) =>
    edge(`seed_${i}`, i === 777 ? 0.05 : 0.1 + (i % 9) / 10),
  );
  const seeded: GraphSnapshot = {
    version: 1,
    topNodes,
    topEdges,
    topDegrees: { a: MAX_SNAPSHOT_EDGES, b: MAX_SNAPSHOT_EDGES },
    stats: { totalNodes: 2, totalEdges: MAX_SNAPSHOT_EDGES, nodesByType: { concept: 2 }, edgesByType: { uses: MAX_SNAPSHOT_EDGES } },
    updatedAt: createdAt,
    dirty: false,
  };
  await kv.set(KV.graphSnapshot, "current", seeded);
  const snapshot = async () => (await kv.get<GraphSnapshot>(KV.graphSnapshot, "current"))!;
  return { kv, snapshot };
}

describe("snapshot topEdges incremental push is capped", () => {
  it("caps at upstream's MAX_SNAPSHOT_EDGES", () => {
    expect(MAX_SNAPSHOT_EDGES).toBe(2000);
  });

  it("evicts exactly the lowest-weight edge when a heavier one arrives", async () => {
    const { kv, snapshot } = await fullSnapshot();
    await persistGraphDelta(kv, [], [edge("heavy", 0.95)]);
    const ids = (await snapshot()).topEdges.map((e) => e.id);
    expect(ids).toHaveLength(MAX_SNAPSHOT_EDGES);
    expect(ids).toContain("heavy");
    expect(ids).not.toContain("seed_777");
    expect(ids.filter((id) => id.startsWith("seed_"))).toHaveLength(MAX_SNAPSHOT_EDGES - 1);
  });

  it("does not cache an edge that is no heavier than the current minimum", async () => {
    const { kv, snapshot } = await fullSnapshot();
    await persistGraphDelta(kv, [], [edge("light", 0.01), edge("tie", 0.05, "imports")]);
    const snap = await snapshot();
    const ids = snap.topEdges.map((e) => e.id);
    expect(ids).toHaveLength(MAX_SNAPSHOT_EDGES);
    expect(ids).not.toContain("light");
    expect(ids).not.toContain("tie");
    expect(ids).toContain("seed_777");
    // The edges are still persisted and counted; only the cache skips them.
    expect(snap.stats.totalEdges).toBe(MAX_SNAPSHOT_EDGES + 2);
    expect(await kv.get(KV.graphEdges, "light")).toMatchObject({ id: "light" });
  });

  it("keeps the dedupe: an id already cached is not pushed twice", async () => {
    const { kv, snapshot } = await fullSnapshot();
    await persistGraphDelta(kv, [], [edge("seed_5", 0.99, "imports")]);
    const ids = (await snapshot()).topEdges.map((e) => e.id);
    expect(ids).toHaveLength(MAX_SNAPSHOT_EDGES);
    expect(ids.filter((id) => id === "seed_5")).toHaveLength(1);
    expect(ids).toContain("seed_777");
  });

  it("pushes 2,001 edges into an empty snapshot and keeps 2,000", async () => {
    const { kv } = createGraphIndexState();
    await initializeGraphIndex(kv, { status: "ready" });
    const nodes = Array.from({ length: 70 }, (_, i) => node(`n${i}`));
    await persistGraphDelta(kv, nodes, []);
    // 70 nodes give 70*69 ordered pairs, enough distinct (src,tgt) keys that
    // none of the 2,001 edges merge on the edge key.
    const edges: GraphEdge[] = [];
    for (let s = 0; s < 70 && edges.length < MAX_SNAPSHOT_EDGES + 1; s++) {
      for (let t = 0; t < 70 && edges.length < MAX_SNAPSHOT_EDGES + 1; t++) {
        if (s === t) continue;
        const i = edges.length;
        edges.push({ ...edge(`e${i}`, i === 0 ? 0.01 : 0.5), sourceNodeId: `n${s}`, targetNodeId: `n${t}` });
      }
    }
    await persistGraphDelta(kv, [], edges);
    const snap = (await kv.get<GraphSnapshot>(KV.graphSnapshot, "current"))!;
    expect(snap.stats.totalEdges).toBe(MAX_SNAPSHOT_EDGES + 1);
    expect(snap.topEdges).toHaveLength(MAX_SNAPSHOT_EDGES);
    expect(snap.topEdges.map((e) => e.id)).not.toContain("e0");
  });
});
