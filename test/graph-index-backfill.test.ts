import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../src/logger.js";
import { registerGraphIndexBackfillFunction } from "../src/functions/graph-index-backfill.js";
import { readAdj, readObsIndex } from "../src/state/graph-store.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

// persistGraphDelta indexes what it writes, so a store that keeps taking
// extracts converges. A store that already holds rows does not, and until those
// rows are indexed the search path finds nothing for them and cascade flags
// nothing for their observations. This is the one-time catch-up.

const node = (i: number, obsIds: string[] = []): GraphNode => ({
  id: `gn_${i}`,
  type: "concept",
  name: `n${i}`,
  properties: {},
  sourceObservationIds: obsIds,
  createdAt: "2026-09-01T00:00:00Z",
});

const edge = (i: number, obsIds: string[] = []): GraphEdge => ({
  id: `ge_${i}`,
  type: "related_to",
  sourceNodeId: `gn_${i}`,
  targetNodeId: `gn_${i + 1}`,
  weight: i,
  sourceObservationIds: obsIds,
  createdAt: "2026-09-01T00:00:00Z",
});

function snapshot(totalNodes: number, totalEdges: number): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: { totalNodes, totalEdges, nodesByType: {}, edgesByType: {} },
    updatedAt: "2026-09-01T00:00:00Z",
    dirty: false,
  };
}

describe("mem::graph-index-backfill", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  const seed = async (nodes: GraphNode[], edges: GraphEdge[]) => {
    for (const n of nodes) await kv.set(KV.graphNodes, n.id, n);
    for (const e of edges) await kv.set(KV.graphEdges, e.id, e);
    // The enumeration guard sizes itself from the snapshot, and refuses a
    // corpus no snapshot vouches for.
    await kv.set(KV.graphSnapshot, "current", snapshot(nodes.length, edges.length));
  };

  const run = (payload: Record<string, unknown> = {}) =>
    sdk.trigger("mem::graph-index-backfill", payload) as Promise<{
      success: boolean;
      processed?: number;
      error?: string;
      alreadyComplete?: boolean;
      cursor: {
        nodesDone: number;
        edgesDone: number;
        pairs: number;
        complete: boolean;
        pairCeilingHit: boolean;
      };
    }>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerGraphIndexBackfillFunction(sdk as never, kv as never);
  });

  it("indexes existing rows into all three scopes", async () => {
    await seed([node(0, ["obs_1"]), node(1, ["obs_1"])], [edge(0, ["obs_1"])]);

    const result = await run();

    expect(result.success).toBe(true);
    expect(result.cursor.complete).toBe(true);
    expect(kv.store.get(KV.graphNames)!.get("gn_0")).toEqual({
      id: "gn_0",
      type: "concept",
      name: "n0",
    });
    expect(await readAdj(kv as never, "gn_0")).toEqual([
      { edgeId: "ge_0", neighborId: "gn_1", weight: 0 },
    ]);
    const obs = await readObsIndex(kv as never, "obs_1");
    expect(obs.nodes.sort()).toEqual(["gn_0", "gn_1"]);
    expect(obs.edges).toEqual(["ge_0"]);
  });

  it("resumes from its cursor and is idempotent across runs", async () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(i, ["obs_1"]));
    await seed(nodes, [edge(0, ["obs_1"]), edge(1, ["obs_1"])]);

    const first = await run({ maxRows: 4 });
    expect(first.cursor.complete).toBe(false);
    expect(first.processed).toBe(4);
    expect(first.cursor.nodesDone).toBe(4);

    // The cursor exists to stop the second run redoing the first run's writes.
    // Every write is a merge, so redoing them is harmless and invisible in the
    // result -- which is exactly why it has to be asserted on the writes.
    const namesWritten: string[] = [];
    const realSet = kv.set;
    kv.set = async <T>(scope: string, key: string, value: T) => {
      if (scope === KV.graphNames) namesWritten.push(key);
      return realSet(scope, key, value);
    };

    const second = await run({ maxRows: 100 });
    expect(second.cursor.complete).toBe(true);
    expect(second.cursor.nodesDone).toBe(6);
    expect(second.cursor.edgesDone).toBe(2);
    expect(namesWritten.sort()).toEqual(["gn_4", "gn_5"]);
    kv.set = realSet;

    // Re-running a complete backfill is a no-op, and the entries did not grow.
    const third = await run();
    expect(third.alreadyComplete).toBe(true);
    const obs = await readObsIndex(kv as never, "obs_1");
    expect(obs.nodes).toHaveLength(6);
    expect(obs.edges).toHaveLength(2);

    const forced = await run({ restart: true });
    expect(forced.cursor.complete).toBe(true);
    expect((await readObsIndex(kv as never, "obs_1")).nodes).toHaveLength(6);
  });

  it("reaches the edges after several runs that the nodes alone exhaust", async () => {
    // processed is per invocation and the edge loop shares the budget, so a
    // store with more nodes than maxRows takes no edges on run one. Confirm
    // that is a delay rather than a floor.
    const nodes = Array.from({ length: 7 }, (_, i) => node(i));
    await seed(nodes, [edge(0), edge(1)]);

    const first = await run({ maxRows: 3 });
    expect(first.cursor.nodesDone).toBe(3);
    expect(first.cursor.edgesDone).toBe(0);

    const second = await run({ maxRows: 3 });
    expect(second.cursor.nodesDone).toBe(6);
    expect(second.cursor.edgesDone).toBe(0);
    expect(await readAdj(kv as never, "gn_0")).toEqual([]);

    const third = await run({ maxRows: 3 });
    expect(third.cursor.nodesDone).toBe(7);
    expect(third.cursor.edgesDone).toBe(2);
    expect(third.cursor.complete).toBe(true);
    expect(await readAdj(kv as never, "gn_0")).toHaveLength(1);
  });

  it("stops transposing provenance at the pair ceiling, and still catalogs", async () => {
    // KTD2 rejects the full transpose at 33,767,235 pairs / 902 MiB. The
    // catch-up takes what it can and stops; names and adjacency are derived
    // from the row itself and are not affected by the ceiling.
    const nodes = [
      node(0, ["obs_a", "obs_b"]),
      node(1, ["obs_c", "obs_d"]),
    ];
    await seed(nodes, []);

    const result = await run({ maxPairs: 2 });

    expect(result.cursor.pairCeilingHit).toBe(true);
    expect(result.cursor.complete).toBe(true);
    expect((await readObsIndex(kv as never, "obs_a")).nodes).toEqual(["gn_0"]);
    expect((await readObsIndex(kv as never, "obs_c")).nodes).toEqual([]);
    // Both rows are in the catalog regardless.
    expect(kv.store.get(KV.graphNames)!.size).toBe(2);
  });

  it("refuses rather than enumerating a corpus over the guard, and says why", async () => {
    await seed([node(0)], []);
    // The state production is in: the snapshot counts a corpus the guard will
    // not let anyone read.
    await kv.set(KV.graphSnapshot, "current", snapshot(20_000, 1));

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.error).toContain("enumeration refused");
    expect(kv.store.get(KV.graphNames)).toBeUndefined();
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.filter(
          ([msg]) => msg === "Graph index backfill refused: enumeration not permitted",
        ),
    ).toHaveLength(1);
  });
});
