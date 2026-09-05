import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  guardedSet,
  persistGraphDelta,
  SNAPSHOT_BUDGET_BYTES,
} from "../src/functions/graph.js";
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
  it("keeps the snapshot write under the budget on a corpus that overflows the row caps", async () => {
    const kv = recordingKV();
    // 520 nodes so topNodes fills its 500 cap with 20 left over, each carrying
    // provenance AND 12 KB of properties. Provenance is what the projection
    // drops; properties survive it, so only the byte bound can bring the cached
    // 500 under 4 MiB. Production's shape at a size a unit test can run.
    const obsIds = Array.from({ length: 200 }, (_, i) => `obs_${i}`);
    const nodes = Array.from({ length: 520 }, (_, i) =>
      node(`n${i}`, obsIds, 12_000),
    );
    const edges = Array.from({ length: 60 }, (_, i) =>
      edge(`e${i}`, `n${i}`, `n${i + 1}`, obsIds),
    );

    await persistGraphDelta(kv as never, nodes, edges, obsIds);

    const snapWrites = kv.writes.filter((w) => w.scope === KV.graphSnapshot);
    expect(snapWrites.length).toBeGreaterThan(0);
    // The literal is the oracle, not the imported constant. Asserting against
    // the import would make the budget its own test: raising it to 64 MiB would
    // raise the assertion with it and the test could never fail.
    expect(SNAPSHOT_BUDGET_BYTES).toBe(4 * 1024 * 1024);
    for (const w of snapWrites) {
      expect(w.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

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

  it("never lowers the recorded row size from a batch of thin rows", async () => {
    const kv = recordingKV();
    // A fat corpus already measured, then a batch of thin new rows. The mean of
    // what THIS batch wrote is small, and taking it would tell the enumeration
    // guard the scope shrank when only the batch was thin.
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 5_000,
        totalEdges: 0,
        nodesByType: { concept: 5_000 },
        edgesByType: {},
        nodeRowBytes: 20_000,
      },
      updatedAt: "2026-09-01T00:00:00Z",
      dirty: false,
    } satisfies GraphSnapshot);

    await persistGraphDelta(kv as never, [node("thin", [], 0)], [], []);

    const snap = kv.store.get(KV.graphSnapshot)!.get("current") as GraphSnapshot;
    expect(snap.stats.nodeRowBytes).toBe(20_000);
  });

  it("does not rewrite the snapshot for a merge-only batch that mutates nothing", async () => {
    const kv = recordingKV();
    const existing = node("existing", ["obs_old"], 0);
    // Seeded OUTSIDE topNodes on purpose: a merge into a cached row sets
    // snapMutated and legitimately rewrites the snapshot, which would pass this
    // assertion for the wrong reason.
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 1,
        totalEdges: 0,
        nodesByType: { concept: 1 },
        edgesByType: {},
      },
      updatedAt: "2026-09-01T00:00:00Z",
      dirty: false,
    } satisfies GraphSnapshot);
    await kv.set(KV.graphNodes, existing.id, existing);
    await kv.set(
      KV.graphNameIndex,
      `${existing.type}|${existing.name}`,
      existing.id,
    );
    kv.writes.length = 0;

    await persistGraphDelta(
      kv as never,
      [{ ...existing, id: "fresh" }],
      [] as GraphEdge[],
      ["obs_old"],
    );

    expect(kv.writes.filter((w) => w.scope === KV.graphSnapshot)).toHaveLength(0);
    // The merge itself still happened; it is the snapshot that stays put.
    expect(kv.writes.map((w) => w.scope)).toContain(KV.graphNodes);
  });
});
