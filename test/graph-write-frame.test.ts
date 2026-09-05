import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { guardedSet, persistGraphDelta } from "../src/functions/graph.js";
import { payloadByteLength } from "../src/state/frame-guard.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// Production wrote a 20,575,104-byte snapshot against a 16,777,216-byte frame,
// the engine closed the socket at the frame header, and the worker re-registered
// (docs/investigations/2026-09-05-graph-write-frame-diagnosis.md). These pin the
// three things that make that write impossible: no graph write is dispatched
// over the frame, snapshot rows carry no provenance, and the snapshot is bounded
// by bytes.

type KVMock = ReturnType<typeof mockKV>;

// Records what each kv.set was handed AT CALL TIME. mockKV stores by reference
// and persistGraphDelta keeps mutating `snap` after the write, so measuring the
// stored object afterwards measures the wrong thing.
function recordingKV(): KVMock & {
  writes: Array<{ scope: string; key: string; bytes: number }>;
} {
  const kv = mockKV();
  const writes: Array<{ scope: string; key: string; bytes: number }> = [];
  const realSet = kv.set;
  kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
    writes.push({
      scope,
      key,
      bytes: payloadByteLength({ scope, key, value: data }),
    });
    return realSet(scope, key, data);
  };
  return Object.assign(kv, { writes });
}

const node = (id: string, obsIds: string[], blobChars: number): GraphNode => ({
  id,
  type: "concept",
  name: id,
  properties: { blob: "x".repeat(blobChars) },
  sourceObservationIds: obsIds,
  createdAt: "2026-09-01T00:00:00Z",
});

const edge = (
  id: string,
  source: string,
  target: string,
  obsIds: string[],
): GraphEdge => ({
  id,
  type: "related_to",
  sourceNodeId: source,
  targetNodeId: target,
  weight: 1,
  sourceObservationIds: obsIds,
  createdAt: "2026-09-01T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("frame-safe graph writes", () => {
  it("caches snapshot rows that carry no observation ids", async () => {
    const kv = recordingKV();
    const obsIds = Array.from({ length: 50 }, (_, i) => `obs_${i}`);
    const nodes = [node("a", obsIds, 0), node("b", obsIds, 0)];
    const edges = [edge("e1", "a", "b", obsIds)];

    await persistGraphDelta(kv as never, nodes, edges, obsIds);

    const snap = kv.store.get(KV.graphSnapshot)!.get("current") as GraphSnapshot;
    expect(snap.topNodes.length).toBeGreaterThan(0);
    expect(snap.topEdges.length).toBeGreaterThan(0);
    for (const n of snap.topNodes) {
      expect(n).not.toHaveProperty("sourceObservationIds");
      expect(n).not.toHaveProperty("sourceBatchIds");
    }
    for (const e of snap.topEdges) {
      expect(e).not.toHaveProperty("sourceObservationIds");
      expect(e).not.toHaveProperty("sourceBatchIds");
    }
    // The stored rows keep theirs: R3 bounds the cache, not the corpus.
    const storedNode = kv.store.get(KV.graphNodes)!.get("a") as GraphNode;
    expect(storedNode.sourceObservationIds).toEqual(obsIds);
  });

  it("refuses an oversized value instead of dispatching it", async () => {
    const kv = recordingKV();
    const value = { blob: "x".repeat(20 * 1024 * 1024) };

    const result = await guardedSet(kv as never, KV.graphNodes, "huge", value);

    expect(result).toMatchObject({ oversized: true, success: false });
    expect(kv.writes).toHaveLength(0);
  });
});
