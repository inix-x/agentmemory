import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../src/logger.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import type {
  ExportData,
  GraphEdge,
  GraphNode,
  GraphQueryResult,
  GraphSnapshot,
} from "../src/types.js";

const NODES = "mem:graph:nodes";
const EDGES = "mem:graph:edges";
const SNAPSHOT = "mem:graph:snapshot";
const GRAPH_FLAG = "GRAPH_EXTRACTION_ENABLED";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listedScopes: string[] = [];
  return {
    listedScopes,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listedScopes.push(scope);
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (id: string, data?: unknown) => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(data);
    },
  };
}

const mockProvider = {
  name: "test",
  compress: vi.fn(),
  summarize: vi.fn().mockResolvedValue(""),
};

function node(name: string, sourceObservationIds: string[] = []): GraphNode {
  return {
    id: `node_${name}`,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds,
    createdAt: "2026-08-01T00:00:00Z",
  } as GraphNode;
}

function edge(src: string, tgt: string): GraphEdge {
  return {
    id: `edge_${src}_${tgt}`,
    type: "related_to",
    sourceNodeId: `node_${src}`,
    targetNodeId: `node_${tgt}`,
    weight: 1,
    sourceObservationIds: [],
    createdAt: "2026-08-01T00:00:00Z",
  } as GraphEdge;
}

function snapshot(
  totalNodes: number,
  extra: Partial<GraphSnapshot> = {},
): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes,
      totalEdges: totalNodes,
      nodesByType: { concept: totalNodes },
      edgesByType: { related_to: totalNodes },
    },
    updatedAt: "2026-08-27T00:00:00Z",
    dirty: false,
    ...extra,
  } as GraphSnapshot;
}

async function seedGraph(kv: ReturnType<typeof mockKV>, names: string[]) {
  for (const n of names) await kv.set(NODES, `node_${n}`, node(n));
  for (let i = 0; i + 1 < names.length; i++) {
    const e = edge(names[i]!, names[i + 1]!);
    await kv.set(EDGES, e.id, e);
  }
}

async function seedRetrievalGraph(
  kv: ReturnType<typeof mockKV>,
  names: string[],
) {
  for (const n of names) {
    await kv.set(NODES, `node_${n}`, node(n, [`obs_${n}`]));
  }
  for (let i = 0; i + 1 < names.length; i++) {
    const e = edge(names[i]!, names[i + 1]!);
    await kv.set(EDGES, e.id, e);
  }
}

function graphScopesListed(kv: ReturnType<typeof mockKV>): string[] {
  return kv.listedScopes.filter((s) => s === NODES || s === EDGES);
}

function warnCallsFor(msg: string): unknown[][] {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter((c) => c[0] === msg) as unknown[][];
}

describe("graph scope enumeration guard", () => {
  const ORIG_FLAG = process.env[GRAPH_FLAG];
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env[GRAPH_FLAG] = "true";
    kv = mockKV();
    sdk = mockSdk();
  });

  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env[GRAPH_FLAG];
    else process.env[GRAPH_FLAG] = ORIG_FLAG;
  });

  describe("mem::graph-query (query / startNodeId branch)", () => {
    it("does not enumerate graph scopes when the snapshot reports a corpus past the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedGraph(kv, ["alpha", "beta"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-query", {
        query: "alpha",
      })) as GraphQueryResult;

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.warning).toBeTruthy();
      expect(result.fromSnapshot).toBe(true);
    });

    it("does not enumerate graph scopes on a post-reset corpus whose snapshot counts zero", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        snapshot(0, { resetAt: "2026-08-26T00:00:00Z" }),
      );
      await seedGraph(kv, ["orphan_a", "orphan_b"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-query", {
        startNodeId: "node_orphan_a",
      })) as GraphQueryResult;

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.warning).toBeTruthy();
    });

    it("does not enumerate graph scopes when no snapshot exists", async () => {
      await seedGraph(kv, ["legacy_a", "legacy_b"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-query", {
        query: "legacy",
      })) as GraphQueryResult;

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.warning).toBeTruthy();
    });

    it("does not enumerate a reset corpus whose snapshot counts only post-reset nodes", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        snapshot(3, { resetAt: "2026-08-26T00:00:00Z" }),
      );
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      await sdk.trigger("mem::graph-query", { query: "alpha" });

      expect(graphScopesListed(kv)).toEqual([]);
    });

    it("still answers a substring query from the live graph under the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-query", {
        query: "bet",
      })) as GraphQueryResult;

      expect(graphScopesListed(kv).sort()).toEqual([EDGES, NODES]);
      expect(result.nodes.map((n) => n.name)).toEqual(["beta"]);
      expect(result.fromSnapshot).toBeFalsy();
    });

    it("still walks from startNodeId on the live graph under the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-query", {
        startNodeId: "node_alpha",
      })) as GraphQueryResult;

      expect(result.nodes.map((n) => n.name).sort()).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
    });
  });

  describe("mem::graph-snapshot-rebuild", () => {
    it("does not enumerate graph scopes when the snapshot reports a corpus past the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedGraph(kv, ["alpha", "beta"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", {})) as {
        success: boolean;
      };

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.success).toBe(false);
    });

    it("does not enumerate graph scopes on a post-reset corpus whose snapshot counts zero", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        snapshot(0, { resetAt: "2026-08-26T00:00:00Z" }),
      );
      await seedGraph(kv, ["orphan_a", "orphan_b"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", {})) as {
        success: boolean;
      };

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.success).toBe(false);
    });

    it("does not enumerate a reset corpus whose snapshot counts only post-reset nodes", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        snapshot(3, { resetAt: "2026-08-26T00:00:00Z" }),
      );
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", {})) as {
        success: boolean;
      };

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.success).toBe(false);
    });

    it("still rebuilds a corpus the snapshot vouches for", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", {})) as {
        success: boolean;
        totalNodes?: number;
        totalEdges?: number;
      };

      expect(result.success).toBe(true);
      expect(result.totalNodes).toBe(3);
      expect(result.totalEdges).toBe(2);
    });
  });

  describe("mem::reflect", () => {
    it("does not enumerate graph scopes when the snapshot reports a corpus past the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedGraph(kv, ["alpha", "beta"]);
      registerReflectFunctions(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        usedFallback: boolean;
      };

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it("degrades to the Jaccard fallback on a legacy corpus with no snapshot", async () => {
      await seedGraph(kv, ["alpha", "beta"]);
      registerReflectFunctions(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        usedFallback: boolean;
      };

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it("does not enumerate a reset corpus whose snapshot counts only post-reset nodes", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        snapshot(3, { resetAt: "2026-08-26T00:00:00Z" }),
      );
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerReflectFunctions(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        usedFallback: boolean;
      };

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.usedFallback).toBe(true);
    });

    it("still clusters from the live graph under the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerReflectFunctions(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        usedFallback: boolean;
      };

      expect(graphScopesListed(kv).sort()).toEqual([EDGES, NODES]);
      expect(result.usedFallback).toBe(false);
    });
  });

  describe("mem::export", () => {
    it("does not enumerate graph scopes when the snapshot reports a corpus past the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedGraph(kv, ["alpha", "beta"]);
      await kv.set("mem:memories", "m_1", {
        id: "m_1",
        project: "p",
        content: "kept",
      });
      registerExportImportFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::export", {})) as ExportData;

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.graphNodes).toBeUndefined();
      expect(result.memories.map((m) => m.id)).toEqual(["m_1"]);
    });

    it("does not enumerate a reset corpus whose snapshot counts only post-reset nodes", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        snapshot(3, { resetAt: "2026-08-26T00:00:00Z" }),
      );
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerExportImportFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::export", {})) as ExportData;

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.graphNodes).toBeUndefined();
    });

    it("still exports the whole graph under the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      registerExportImportFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::export", {})) as ExportData;

      expect(graphScopesListed(kv).sort()).toEqual([EDGES, NODES]);
      expect(result.graphNodes?.map((n) => n.name).sort()).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
      expect(result.graphEdges).toHaveLength(2);
    });

    it("omits both graph collections when only one graph scope fails to enumerate", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedGraph(kv, ["alpha", "beta", "gamma"]);
      const passthrough = kv.list;
      kv.list = (async <T>(scope: string): Promise<T[]> => {
        if (scope === EDGES) {
          throw new Error("Invocation timeout after 180000ms: state::list");
        }
        return passthrough<T>(scope);
      }) as typeof kv.list;
      registerExportImportFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::export", {})) as ExportData;

      expect(result.graphEdges).toBeUndefined();
      expect(result.graphNodes).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "Graph scope enumeration failed",
        expect.objectContaining({ caller: "mem::export", scope: EDGES }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "Export omitted graph collections",
        expect.anything(),
      );
    });
  });

  describe("GraphRetrieval (mem::search / mem::smart-search graph stream)", () => {
    let clock = Date.parse("2026-08-27T00:00:00Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      clock += 10 * 60_000;
      vi.setSystemTime(clock);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not enumerate graph scopes for entity search when the snapshot reports a corpus past the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      const results = await new GraphRetrieval(kv as never).searchByEntities([
        "alpha",
      ]);

      expect(graphScopesListed(kv)).toEqual([]);
      expect(results).toEqual([]);
    });

    it("does not enumerate graph scopes for chunk expansion when the snapshot reports a corpus past the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      const results = await new GraphRetrieval(kv as never).expandFromChunks([
        "obs_alpha",
      ]);

      expect(graphScopesListed(kv)).toEqual([]);
      expect(results).toEqual([]);
    });

    it("does not enumerate graph scopes for temporal queries when the snapshot reports a corpus past the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      const result = await new GraphRetrieval(kv as never).temporalQuery(
        "alpha",
      );

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.entity).toBeNull();
    });

    it("does not enumerate graph scopes for entity search on a legacy corpus with no snapshot", async () => {
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
    });

    it("does not enumerate a reset corpus whose snapshot counts only post-reset nodes", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        snapshot(3, { resetAt: "2026-08-26T00:00:00Z" }),
      );
      await seedRetrievalGraph(kv, ["alpha", "beta", "gamma"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
    });

    it("names the caller, the refused scopes and the ceiling in a warning", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(warnCallsFor("Graph scope enumeration refused")).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "Graph scope enumeration refused",
        expect.objectContaining({
          caller: "GraphRetrieval.searchByEntities",
          scopes: `${NODES}, ${EDGES}`,
          totalNodes: 30000,
          ceiling: 25000,
        }),
      );
    });

    it("throttles the refusal warning rather than logging once per search", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedRetrievalGraph(kv, ["alpha", "beta"]);
      const retrieval = new GraphRetrieval(kv as never);

      for (let i = 0; i < 5; i++) await retrieval.searchByEntities(["alpha"]);
      expect(warnCallsFor("Graph scope enumeration refused")).toHaveLength(1);

      vi.setSystemTime(clock + 61_000);
      await retrieval.searchByEntities(["alpha"]);

      const calls = warnCallsFor("Graph scope enumeration refused");
      expect(calls).toHaveLength(2);
      expect(calls[1]![1]).toMatchObject({ suppressedSinceLastWarning: 4 });
    });

    it("warns again after the clock steps backwards rather than suppressing until it catches up", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(30000));
      await seedRetrievalGraph(kv, ["alpha", "beta"]);
      const retrieval = new GraphRetrieval(kv as never);

      await retrieval.searchByEntities(["alpha"]);
      expect(warnCallsFor("Graph scope enumeration refused")).toHaveLength(1);

      vi.setSystemTime(clock - 60 * 60_000);
      await retrieval.searchByEntities(["alpha"]);

      expect(warnCallsFor("Graph scope enumeration refused")).toHaveLength(2);
    });

    it("still answers an entity search from the live graph under the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedRetrievalGraph(kv, ["alpha", "beta", "gamma"]);

      const results = await new GraphRetrieval(kv as never).searchByEntities(
        ["alpha"],
        2,
      );

      expect(graphScopesListed(kv).sort()).toEqual([EDGES, NODES]);
      expect(results.map((r) => r.obsId).sort()).toEqual([
        "obs_alpha",
        "obs_beta",
        "obs_gamma",
      ]);
      expect(results.find((r) => r.obsId === "obs_alpha")!.score).toBe(1);
      expect(warnCallsFor("Graph scope enumeration refused")).toHaveLength(0);
    });

    it("still expands from chunks on the live graph under the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedRetrievalGraph(kv, ["alpha", "beta", "gamma"]);

      const results = await new GraphRetrieval(kv as never).expandFromChunks([
        "obs_alpha",
      ]);

      expect(graphScopesListed(kv).sort()).toEqual([EDGES, NODES]);
      expect(results.map((r) => r.obsId)).toEqual(["obs_beta"]);
    });

    it("still answers a temporal query on the live graph under the ceiling", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedRetrievalGraph(kv, ["alpha", "beta", "gamma"]);

      const result = await new GraphRetrieval(kv as never).temporalQuery(
        "beta",
      );

      expect(graphScopesListed(kv).sort()).toEqual([EDGES, NODES]);
      expect(result.entity?.name).toBe("beta");
      expect(result.currentState).toHaveLength(2);
    });

    it("reports a swallowed enumeration failure instead of returning a silently empty graph", async () => {
      await kv.set(SNAPSHOT, "current", snapshot(3));
      await seedRetrievalGraph(kv, ["alpha", "beta"]);
      kv.list = async () => {
        throw new Error("Invocation timeout after 180000ms: state::list");
      };

      const results = await new GraphRetrieval(kv as never).searchByEntities([
        "alpha",
      ]);

      expect(results).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Graph scope enumeration failed",
        expect.objectContaining({
          caller: "GraphRetrieval.searchByEntities",
          scope: NODES,
          error: "Invocation timeout after 180000ms: state::list",
        }),
      );
    });
  });

  describe("per-scope byte budget", () => {
    const FRAME_CAP = 104_857_600;
    const BYTE_BUDGET = FRAME_CAP / 2;
    const BYTES_PER_NODE = 4481;
    const BYTES_PER_EDGE = 3036;
    let clock = Date.parse("2026-09-01T00:00:00Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      clock += 10 * 60_000;
      vi.setSystemTime(clock);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function sizedSnapshot(opts: {
      totalNodes: number;
      totalEdges: number;
      topNodes?: GraphNode[];
      topEdges?: GraphEdge[];
      resetAt?: string;
    }): GraphSnapshot {
      return {
        version: 1,
        topNodes: opts.topNodes ?? [],
        topEdges: opts.topEdges ?? [],
        topDegrees: {},
        stats: {
          totalNodes: opts.totalNodes,
          totalEdges: opts.totalEdges,
          nodesByType: { concept: opts.totalNodes },
          edgesByType: { related_to: opts.totalEdges },
        },
        updatedAt: "2026-08-27T00:00:00Z",
        dirty: false,
        ...(opts.resetAt ? { resetAt: opts.resetAt } : {}),
      } as GraphSnapshot;
    }

    function fatNode(i: number): GraphNode {
      return {
        ...node(`fat-${i}`),
        properties: { blob: "x".repeat(20_000) },
      } as GraphNode;
    }

    function refusalFields(): Record<string, unknown> {
      const calls = warnCallsFor("Graph scope enumeration refused");
      return calls[0]![1] as Record<string, unknown>;
    }

    it("refuses a node scope over the byte budget whose node count clears the count ceiling", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        sizedSnapshot({ totalNodes: 20_000, totalEdges: 1 }),
      );
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
      expect(refusalFields()).toMatchObject({
        blockedScope: NODES,
        estimatedNodeBytes: 20_000 * BYTES_PER_NODE,
        byteBudget: BYTE_BUDGET,
      });
      expect(20_000 * BYTES_PER_NODE).toBeGreaterThan(BYTE_BUDGET);
    });

    it("refuses an edge scope over the byte budget while the node scope fits", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        sizedSnapshot({ totalNodes: 1_000, totalEdges: 34_420 }),
      );
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
      expect(1_000 * BYTES_PER_NODE).toBeLessThan(BYTE_BUDGET);
      expect(34_420 * BYTES_PER_EDGE).toBeGreaterThan(BYTE_BUDGET);
      expect(refusalFields()).toMatchObject({
        blockedScope: EDGES,
        totalEdges: 34_420,
        estimatedEdgeBytes: 34_420 * BYTES_PER_EDGE,
      });
    });

    it("refuses an edge scope that clears the raw frame cap but not the halved budget", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        sizedSnapshot({ totalNodes: 1_000, totalEdges: 20_000 }),
      );
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(20_000 * BYTES_PER_EDGE).toBeLessThan(FRAME_CAP);
      expect(20_000 * BYTES_PER_EDGE).toBeGreaterThan(BYTE_BUDGET);
      expect(graphScopesListed(kv)).toEqual([]);
      expect(refusalFields()).toMatchObject({ blockedScope: EDGES });
    });

    it("refuses a corpus whose sampled rows are fat enough to blow the budget under the calibrated floor", async () => {
      const topNodes = [0, 1, 2, 3, 4].map(fatNode);
      await kv.set(
        SNAPSHOT,
        "current",
        sizedSnapshot({ totalNodes: 5_000, totalEdges: 1, topNodes }),
      );
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(5_000 * BYTES_PER_NODE).toBeLessThan(BYTE_BUDGET);
      expect(graphScopesListed(kv)).toEqual([]);
      const fields = refusalFields();
      expect(fields.blockedScope).toBe(NODES);
      expect(fields.estimatedNodeBytes as number).toBeGreaterThan(BYTE_BUDGET);
    });

    it("still enumerates a corpus whose node and edge scopes both fit the budget", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        sizedSnapshot({ totalNodes: 1_000, totalEdges: 12_000 }),
      );
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      const results = await new GraphRetrieval(kv as never).searchByEntities([
        "alpha",
      ]);

      expect(12_000 * BYTES_PER_EDGE).toBeLessThan(BYTE_BUDGET);
      expect(graphScopesListed(kv).sort()).toEqual([EDGES, NODES]);
      expect(results.map((r) => r.obsId).sort()).toEqual([
        "obs_alpha",
        "obs_beta",
      ]);
      expect(warnCallsFor("Graph scope enumeration refused")).toHaveLength(0);
    });

    it("reports null byte estimates rather than a fitting scope when no snapshot exists", async () => {
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
      expect(refusalFields()).toMatchObject({
        totalNodes: null,
        totalEdges: null,
        estimatedNodeBytes: null,
        estimatedEdgeBytes: null,
        byteBudget: BYTE_BUDGET,
      });
    });

    it("refuses a snapshot that does not count nodes without claiming a count", async () => {
      const unsizable = sizedSnapshot({ totalNodes: 0, totalEdges: 0 });
      delete (unsizable.stats as { totalNodes?: number }).totalNodes;
      await kv.set(SNAPSHOT, "current", unsizable);
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
      expect(refusalFields()).toMatchObject({
        estimatedNodeBytes: null,
        reason: `the snapshot does not count the rows in ${NODES}`,
      });
    });

    it("refuses a snapshot that counts nodes but does not count edges", async () => {
      const unsizable = sizedSnapshot({ totalNodes: 1_000, totalEdges: 0 });
      delete (unsizable.stats as { totalEdges?: number }).totalEdges;
      await kv.set(SNAPSHOT, "current", unsizable);
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
      expect(refusalFields()).toMatchObject({
        blockedScope: EDGES,
        estimatedEdgeBytes: null,
      });
    });

    it("blames the reset rather than a scope when the corpus carries orphan rows", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        sizedSnapshot({
          totalNodes: 3,
          totalEdges: 2,
          resetAt: "2026-08-26T00:00:00Z",
        }),
      );
      await seedRetrievalGraph(kv, ["alpha", "beta", "gamma"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
      expect(refusalFields()).toMatchObject({ blockedScope: null });
    });

    it("refuses production's measured 29,074 nodes / 34,420 edges on both scopes", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        sizedSnapshot({ totalNodes: 29_074, totalEdges: 34_420 }),
      );
      await seedRetrievalGraph(kv, ["alpha", "beta"]);

      await new GraphRetrieval(kv as never).searchByEntities(["alpha"]);

      expect(graphScopesListed(kv)).toEqual([]);
      const fields = refusalFields();
      expect(fields.estimatedNodeBytes as number).toBeGreaterThan(BYTE_BUDGET);
      expect(fields.estimatedEdgeBytes as number).toBeGreaterThan(BYTE_BUDGET);
      expect(fields.blockedScope).toBe(NODES);
    });

    it("marks a rebuild refused on edge bytes alone as tooLarge", async () => {
      await kv.set(
        SNAPSHOT,
        "current",
        sizedSnapshot({ totalNodes: 1_000, totalEdges: 34_420 }),
      );
      await seedGraph(kv, ["alpha", "beta"]);
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);

      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", {})) as {
        success: boolean;
        tooLarge?: boolean;
        legacyCorpus?: boolean;
        error?: string;
      };

      expect(graphScopesListed(kv)).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.tooLarge).toBe(true);
      expect(result.legacyCorpus).toBe(false);
      expect(result.error).toContain(EDGES);
    });
  });
});
