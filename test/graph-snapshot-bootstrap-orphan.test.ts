import { describe, it, expect, vi } from "vitest";
import { persistGraphDelta } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge, GraphSnapshot } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// readSnapshot returns null for BOTH "no snapshot yet" and "the read
// failed" — it catches and logs. Conflating those is what let a 414 MB
// graph scope look enumerable in production:
//
//   worker death -> readSnapshot fails -> null -> bootstrap an empty
//   snapshot with NO resetAt -> the write overwrites the real snapshot,
//   so 31,038 rows on disk become invisible and unmarked ->
//   checkGraphEnumerable sees a tiny totalNodes with no orphan flag ->
//   GraphRetrieval enumerates the whole scope -> frame past the ws
//   100 MiB maxPayload -> RangeError, close 1009 -> worker dies -> loop.
//
// Observed: 46 MAXPAYLOAD frames, 24 deaths, 2xx 99% -> 23.7%, and
// /observe lost 1514 writes in 30 minutes.
function mockKV(opts: { getThrows?: boolean; existing?: GraphSnapshot } = {}) {
  const store = new Map<string, Map<string, unknown>>();
  if (opts.existing) {
    store.set(KV.graphSnapshot, new Map([["current", opts.existing]]));
  }
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      if (opts.getThrows && scope === KV.graphSnapshot) {
        throw new Error("Invocation timeout after 30000ms: state::get");
      }
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async () => undefined,
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

const node = (id: string): GraphNode =>
  ({
    id,
    type: "concept",
    name: id,
    observationIds: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  }) as GraphNode;

function writtenSnapshot(kv: ReturnType<typeof mockKV>): GraphSnapshot {
  return kv.store.get(KV.graphSnapshot)!.get("current") as GraphSnapshot;
}

describe("persistGraphDelta bootstrap cannot vouch for an uncounted scope", () => {
  it("stamps resetAt when the snapshot read FAILS", async () => {
    // The production case: a dying worker makes state::get time out.
    const kv = mockKV({ getThrows: true });

    await persistGraphDelta(kv as never, [node("n1")], [] as GraphEdge[], []);

    const snap = writtenSnapshot(kv);
    expect(snap.resetAt).toBeTruthy();
    expect(Date.parse(snap.resetAt as string)).toBeGreaterThan(0);
  });

  it("does NOT stamp resetAt on a cold start (genuinely absent)", async () => {
    // An absent snapshot means nothing is on disk yet, so there are no
    // uncounted rows to protect against. Marking this orphaned would leave
    // every fresh install permanently degraded: graph-query would refuse
    // to enumerate and BFS traversal would never run. That regression is
    // exactly what an earlier version of this fix caused, caught by
    // graph.test.ts "graph-query with startNodeId does BFS traversal".
    const kv = mockKV();

    await persistGraphDelta(kv as never, [node("n1")], [] as GraphEdge[], []);

    expect(writtenSnapshot(kv).resetAt).toBeUndefined();
  });

  it("does NOT stamp resetAt when a real snapshot was read", async () => {
    // A snapshot that counted the corpus keeps vouching for it; this
    // guard must not disable healthy graphs.
    const existing: GraphSnapshot = {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: { totalNodes: 5, totalEdges: 0, nodesByType: {}, edgesByType: {} },
      updatedAt: "2026-09-01T00:00:00Z",
      dirty: false,
    } as GraphSnapshot;
    const kv = mockKV({ existing });

    await persistGraphDelta(kv as never, [node("n2")], [] as GraphEdge[], []);

    expect(writtenSnapshot(kv).resetAt).toBeUndefined();
  });
});
