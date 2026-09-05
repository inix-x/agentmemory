import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../src/logger.js";
import { registerCascadeFunction } from "../src/functions/cascade.js";
import { persistGraphDelta } from "../src/functions/graph.js";
import type { Memory, GraphNode, GraphEdge } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("Cascade Update Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerCascadeFunction(sdk as never, kv as never);
    // Cascade now reads the graph through the enumeration guard instead of a
    // raw kv.list, and the guard refuses a corpus no snapshot vouches for. Seed
    // the snapshot persistGraphDelta would have written -- the same fixture
    // graph-retrieval.test.ts carries for the same reason. Counts are
    // deliberately non-zero: the guard sizes itself from totalNodes.
    await kv.set("mem:graph:snapshot", "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: { totalNodes: 2, totalEdges: 2, nodesByType: {}, edgesByType: {} },
      updatedAt: "2026-03-01T00:00:00Z",
      dirty: false,
    });
  });

  it("returns error when supersededMemoryId is missing", async () => {
    const result = (await sdk.trigger("mem::cascade-update", {})) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("supersededMemoryId is required");
  });

  it("returns error for non-existent memory", async () => {
    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_missing",
    })) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe("superseded memory not found");
  });

  it("flags graph nodes referencing superseded observation IDs", async () => {
    const memory: Memory = {
      id: "mem_old",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Old fact",
      content: "Old content",
      concepts: ["react"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_a", "obs_b"],
    };
    await kv.set("mem:memories", "mem_old", memory);

    const node: GraphNode = {
      id: "node_1",
      type: "concept",
      name: "react",
      properties: {},
      sourceObservationIds: ["obs_a"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:graph:nodes", "node_1", node);

    const unrelatedNode: GraphNode = {
      id: "node_2",
      type: "file",
      name: "index.ts",
      properties: {},
      sourceObservationIds: ["obs_c"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:graph:nodes", "node_2", unrelatedNode);

    // Cascade reads mem:graph:obs-index now instead of enumerating both scopes
    // and testing every row's provenance. persistGraphDelta writes these
    // entries; seeded directly here so the test stays about cascade.
    await kv.set("mem:graph:obs-index", "obs_a", {
      nodes: ["node_1"],
      edges: [],
    });
    await kv.set("mem:graph:obs-index", "obs_c", {
      nodes: ["node_2"],
      edges: [],
    });

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old",
    })) as { success: boolean; flagged: { nodes: number; edges: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.nodes).toBe(1);

    const updated = await kv.get<GraphNode>("mem:graph:nodes", "node_1");
    expect(updated!.stale).toBe(true);

    const unchanged = await kv.get<GraphNode>("mem:graph:nodes", "node_2");
    expect(unchanged!.stale).toBeUndefined();
  });

  it("flags graph edges referencing superseded observation IDs", async () => {
    const memory: Memory = {
      id: "mem_old2",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "pattern",
      title: "Old pattern",
      content: "Old pattern content",
      concepts: ["testing"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_x"],
    };
    await kv.set("mem:memories", "mem_old2", memory);

    const edge: GraphEdge = {
      id: "edge_1",
      type: "uses",
      sourceNodeId: "node_a",
      targetNodeId: "node_b",
      weight: 1,
      sourceObservationIds: ["obs_x", "obs_y"],
      createdAt: "2026-03-01T00:00:00Z",
    };
    await kv.set("mem:graph:edges", "edge_1", edge);
    await kv.set("mem:graph:obs-index", "obs_x", {
      nodes: [],
      edges: ["edge_1"],
    });

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old2",
    })) as { success: boolean; flagged: { edges: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.edges).toBe(1);

    const updated = await kv.get<GraphEdge>("mem:graph:edges", "edge_1");
    expect(updated!.stale).toBe(true);
  });

  it("counts sibling memories sharing 2+ concepts", async () => {
    const superseded: Memory = {
      id: "mem_superseded",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "architecture",
      title: "React architecture",
      content: "Old arch",
      concepts: ["react", "frontend", "typescript"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
    };
    await kv.set("mem:memories", "mem_superseded", superseded);

    const sibling: Memory = {
      id: "mem_sibling",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "pattern",
      title: "React patterns",
      content: "Sibling memory sharing concepts",
      concepts: ["react", "typescript"],
      files: [],
      sessionIds: [],
      strength: 6,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_sibling", sibling);

    const unrelated: Memory = {
      id: "mem_unrelated",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Python setup",
      content: "Unrelated memory",
      concepts: ["python", "backend"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_unrelated", unrelated);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_superseded",
    })) as { success: boolean; flagged: { siblingMemories: number }; total: number };

    expect(result.success).toBe(true);
    expect(result.flagged.siblingMemories).toBe(1);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("skips already stale nodes", async () => {
    const memory: Memory = {
      id: "mem_skip",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Skip test",
      content: "Content",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_s"],
    };
    await kv.set("mem:memories", "mem_skip", memory);

    const node: GraphNode = {
      id: "node_stale",
      type: "concept",
      name: "already stale",
      properties: {},
      sourceObservationIds: ["obs_s"],
      createdAt: "2026-03-01T00:00:00Z",
      stale: true,
    };
    await kv.set("mem:graph:nodes", "node_stale", node);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_skip",
    })) as { success: boolean; flagged: { nodes: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.nodes).toBe(0);
  });

  it("does not flag siblings when fewer than 2 shared concepts", async () => {
    const memory: Memory = {
      id: "mem_one_concept",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "One concept",
      content: "Content",
      concepts: ["react"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
    };
    await kv.set("mem:memories", "mem_one_concept", memory);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_one_concept",
    })) as { success: boolean; flagged: { siblingMemories: number } };

    expect(result.success).toBe(true);
    expect(result.flagged.siblingMemories).toBe(0);
  });

  it("returns zero counts when no sourceObservationIds and < 2 concepts", async () => {
    const memory: Memory = {
      id: "mem_empty",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Empty refs",
      content: "No references",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
    };
    await kv.set("mem:memories", "mem_empty", memory);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_empty",
    })) as { success: boolean; total: number };

    expect(result.success).toBe(true);
    expect(result.total).toBe(0);
  });
});

// U3 + R6. Cascade used to read the whole corpus and test provenance membership
// on every row, which the enumeration guard refuses on a graph over the budget,
// which is the state production has been in since 2026-09-01T19:04:13Z. The
// inverted index answers in the direction cascade actually asks.
describe("Cascade flags through mem:graph:obs-index", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  const memory = (obsIds: string[]): Memory => ({
    id: "mem_old",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    type: "fact",
    title: "Old fact",
    content: "Old content",
    concepts: [],
    sourceObservationIds: obsIds,
    isLatest: false,
  } as Memory);

  const node = (id: string, name: string): GraphNode => ({
    id,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [],
    createdAt: "2026-09-01T00:00:00Z",
  });

  const edge = (id: string, source: string, target: string): GraphEdge => ({
    id,
    type: "related_to",
    sourceNodeId: source,
    targetNodeId: target,
    weight: 1,
    sourceObservationIds: [],
    createdAt: "2026-09-01T00:00:00Z",
  });

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerCascadeFunction(sdk as never, kv as never);
  });

  it("flags the same rows with kv.list on the graph scopes throwing", async () => {
    await persistGraphDelta(
      kv as never,
      [node("gn_a", "Alpha"), node("gn_b", "Beta")],
      [edge("ge_1", "gn_a", "gn_b")],
      ["obs_1"],
    );
    await persistGraphDelta(
      kv as never,
      [node("gn_c", "Gamma")],
      [] as GraphEdge[],
      ["obs_other"],
    );
    await kv.set("mem:memories", "mem_old", memory(["obs_1"]));
    // The read cascade must not need. On a refused corpus this is what the
    // engine does to the worker, so the stub is the production condition.
    kv.list = async (scope: string) => {
      if (scope.startsWith("mem:graph:")) throw new Error("kv.list refused");
      return [];
    };

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old",
    })) as { flagged: { nodes: number; edges: number }; warning?: string };

    expect(result.flagged.nodes).toBe(2);
    expect(result.flagged.edges).toBe(1);
    expect(result.warning).toBeUndefined();
    // The row an unrelated observation produced is untouched.
    const gamma = kv.store.get("mem:graph:nodes")!.get("gn_c") as GraphNode;
    expect(gamma.stale).toBeUndefined();
    const alpha = kv.store.get("mem:graph:nodes")!.get("gn_a") as GraphNode;
    expect(alpha.stale).toBe(true);
  });

  it("flags an edge whose observation overlaps even when no node does", async () => {
    // The plan writes obs-index as obsId -> [nodeId]. This is the case that
    // shape cannot serve, and R6 requires it.
    await persistGraphDelta(
      kv as never,
      [node("gn_a", "Alpha"), node("gn_b", "Beta")],
      [] as GraphEdge[],
      ["obs_nodes"],
    );
    await persistGraphDelta(
      kv as never,
      [] as GraphNode[],
      [edge("ge_1", "gn_a", "gn_b")],
      ["obs_edge"],
    );
    await kv.set("mem:memories", "mem_old", memory(["obs_edge"]));

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old",
    })) as { flagged: { nodes: number; edges: number } };

    expect(result.flagged.edges).toBe(1);
    expect(result.flagged.nodes).toBe(0);
  });

  it("says so loudly when the rows predate the index", async () => {
    // Rows on disk, no obs-index behind them: exactly an imported store, or one
    // deployed before U3. Flagging nothing is the honest answer, and it has to
    // be an answer rather than a silent zero.
    await kv.set("mem:graph:nodes", "gn_a", node("gn_a", "Alpha"));
    await kv.set("mem:memories", "mem_old", memory(["obs_1"]));

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old",
    })) as { flagged: { nodes: number }; warning?: string };

    expect(result.flagged.nodes).toBe(0);
    expect(result.warning).toContain("mem::graph-index-backfill");
    const warned = vi
      .mocked(logger.warn)
      .mock.calls.filter(
        ([msg]) => msg === "Cascade found no obs-index entries for the superseded memory",
      );
    expect(warned).toHaveLength(1);
  });
});
