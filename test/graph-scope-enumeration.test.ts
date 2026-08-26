import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import type {
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

function node(name: string): GraphNode {
  return {
    id: `node_${name}`,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [],
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

function graphScopesListed(kv: ReturnType<typeof mockKV>): string[] {
  return kv.listedScopes.filter((s) => s === NODES || s === EDGES);
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
});
