import { describe, it, expect } from "vitest";

import {
  GRAPH_ADJ_CAP,
  flushIndexDelta,
  mergeAdj,
  mergeObsIndex,
  newIndexDelta,
  putGraphEdgeRow,
  putGraphNodeRow,
  readAdj,
  readObsIndex,
  recordEdgeAdjacency,
  recordNodeName,
  recordRowObservations,
  type GraphAdjStub,
} from "../src/state/graph-store.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// The store owns the row-plus-index invariants. These pin the three that make an
// append safe: an entry never changes once written, a replayed extract does not
// duplicate, and the adjacency fanout has a ceiling that survives a batch which
// adds more than the cap in one call.

const node = (id: string, name = id): GraphNode => ({
  id,
  type: "concept",
  name,
  properties: {},
  sourceObservationIds: [],
  createdAt: "2026-09-01T00:00:00Z",
});

const edge = (id: string, source: string, target: string, weight = 1): GraphEdge => ({
  id,
  type: "related_to",
  sourceNodeId: source,
  targetNodeId: target,
  weight,
  sourceObservationIds: [],
  createdAt: "2026-09-01T00:00:00Z",
});

function writerFor(kv: ReturnType<typeof mockKV>) {
  const writes: Array<{ scope: string; key: string }> = [];
  const write = async <T>(scope: string, key: string, value: T) => {
    writes.push({ scope, key });
    return kv.set(scope, key, value);
  };
  return { write, writes };
}

describe("graph-store index invariants", () => {
  it("caps adjacency at 64 stubs by weight across a whole batch", async () => {
    const kv = mockKV();
    const { write } = writerFor(kv);
    const delta = newIndexDelta();
    // 100 edges onto one hub in a single call. Capping on each append would let
    // an early low-weight stub survive a later high-weight one.
    for (let i = 0; i < 100; i++) {
      recordEdgeAdjacency(delta, edge(`e${i}`, "hub", `n${i}`, i));
    }

    await flushIndexDelta(kv as never, delta, write);

    const stubs = await readAdj(kv as never, "hub");
    expect(stubs).toHaveLength(GRAPH_ADJ_CAP);
    expect(stubs[0]!.weight).toBe(99);
    expect(stubs[GRAPH_ADJ_CAP - 1]!.weight).toBe(100 - GRAPH_ADJ_CAP);
    expect(stubs.map((s) => s.edgeId)).not.toContain("e0");
  });

  it("dedupes a replayed append instead of growing the entry", async () => {
    const kv = mockKV();
    const { write } = writerFor(kv);
    const run = async () => {
      const delta = newIndexDelta();
      recordEdgeAdjacency(delta, edge("e1", "a", "b", 3));
      recordRowObservations(delta, ["obs_1"], "a", "node");
      recordRowObservations(delta, ["obs_1"], "e1", "edge");
      recordNodeName(delta, node("a"));
      await flushIndexDelta(kv as never, delta, write);
    };

    await run();
    await run();

    expect(await readAdj(kv as never, "a")).toHaveLength(1);
    const obs = await readObsIndex(kv as never, "obs_1");
    expect(obs.nodes).toEqual(["a"]);
    expect(obs.edges).toEqual(["e1"]);
  });

  it("keeps node and edge row ids apart in one obs-index entry", async () => {
    const kv = mockKV();
    const { write } = writerFor(kv);
    const delta = newIndexDelta();
    recordRowObservations(delta, ["obs_1", "obs_2"], "gn_a", "node");
    recordRowObservations(delta, ["obs_2"], "ge_1", "edge");

    await flushIndexDelta(kv as never, delta, write);

    expect(await readObsIndex(kv as never, "obs_1")).toEqual({
      nodes: ["gn_a"],
      edges: [],
    });
    expect(await readObsIndex(kv as never, "obs_2")).toEqual({
      nodes: ["gn_a"],
      edges: ["ge_1"],
    });
  });

  it("writes one entry per distinct key however many rows touched it", async () => {
    const kv = mockKV();
    const { write, writes } = writerFor(kv);
    const delta = newIndexDelta();
    for (let i = 0; i < 20; i++) {
      recordEdgeAdjacency(delta, edge(`e${i}`, "hub", `n${i}`, 1));
      recordRowObservations(delta, ["obs_1"], `e${i}`, "edge");
    }

    await flushIndexDelta(kv as never, delta, write);

    // 20 edges onto one hub is one adjacency write, not 20, and one obs-index
    // write, not 20. The 20 neighbour keys each take their own.
    expect(writes.filter((w) => w.scope === KV.graphAdj && w.key === "hub")).toHaveLength(1);
    expect(writes.filter((w) => w.scope === KV.graphObsIndex)).toHaveLength(1);
  });

  it("derives catalog and adjacency from a restored row, and never obs-index", async () => {
    const kv = mockKV();
    const { write } = writerFor(kv);

    await putGraphNodeRow(node("gn_a", "Alpha"), write);
    await putGraphEdgeRow(kv as never, edge("ge_1", "gn_a", "gn_b", 2), write);

    expect(kv.store.get(KV.graphNodes)!.get("gn_a")).toBeTruthy();
    expect(kv.store.get(KV.graphNames)!.get("gn_a")).toEqual({
      id: "gn_a",
      type: "concept",
      name: "Alpha",
    });
    expect(await readAdj(kv as never, "gn_a")).toEqual([
      { edgeId: "ge_1", neighborId: "gn_b", weight: 2 },
    ]);
    // A restore has no extraction event behind it, so obs-index stays the
    // backfill's job rather than a transpose of the row's provenance.
    expect(kv.store.get(KV.graphObsIndex)).toBeUndefined();
  });

  it("merges by edge id so a stub is replaced, not duplicated", () => {
    const existing: GraphAdjStub[] = [
      { edgeId: "e1", neighborId: "b", weight: 1 },
    ];
    const merged = mergeAdj(existing, [
      { edgeId: "e1", neighborId: "b", weight: 5 },
    ]);
    expect(merged).toEqual([{ edgeId: "e1", neighborId: "b", weight: 5 }]);
  });

  it("leaves an existing obs-index entry's ids in place when adding", () => {
    expect(
      mergeObsIndex({ nodes: ["a"], edges: ["e1"] }, ["b"], ["e1", "e2"]),
    ).toEqual({ nodes: ["a", "b"], edges: ["e1", "e2"] });
  });
});
