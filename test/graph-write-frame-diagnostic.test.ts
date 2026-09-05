import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../src/logger.js";
import { persistGraphDelta } from "../src/functions/graph.js";
import { payloadByteLength } from "../src/state/frame-guard.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// Production: every graph-extract worker death sits within seconds of a
// state::set dispatch, the snapshot on disk is 5 KB under the engine's
// 16 MiB frame, and no write in graph.ts measures what it hands the SDK.
// These pin the diagnostic: the bytes of an oversized write reach the log,
// once, before the write, so they survive the write never returning.

const WARN_BYTES = 8 * 1024 * 1024;

const node = (id: string): GraphNode => ({
  id,
  type: "concept",
  name: id,
  properties: {},
  sourceObservationIds: [],
  createdAt: "2026-09-01T00:00:00Z",
});

// One top node carrying 9 MiB stands in for production's 500 top nodes whose
// unioned sourceObservationIds add up to the same order of magnitude.
function bigSnapshot(): GraphSnapshot {
  const hub: GraphNode = {
    ...node("hub"),
    properties: { blob: "x".repeat(9 * 1024 * 1024) },
  };
  return {
    version: 1,
    topNodes: [hub],
    topEdges: [],
    topDegrees: { hub: 0 },
    stats: { totalNodes: 1, totalEdges: 0, nodesByType: { concept: 1 }, edgesByType: {} },
    updatedAt: "2026-09-01T00:00:00Z",
    dirty: false,
  };
}

const snapshotPayload = (kv: ReturnType<typeof mockKV>) => ({
  scope: KV.graphSnapshot,
  key: "current",
  value: kv.store.get(KV.graphSnapshot)!.get("current"),
});

const warnCalls = () => vi.mocked(logger.warn).mock.calls;
const summaryCalls = () =>
  vi.mocked(logger.info).mock.calls.filter(([msg]) => msg === "Graph delta persisted");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("graph write frame diagnostic", () => {
  it("warns once, with the bytes state::set is handed, when the snapshot write crosses 8 MiB", async () => {
    const kv = mockKV();
    const existing = bigSnapshot();
    await kv.set(KV.graphSnapshot, "current", existing);
    // The fixture must actually cross the line, or the test is a no-op.
    expect(payloadByteLength(snapshotPayload(kv))).toBeGreaterThan(WARN_BYTES);

    await persistGraphDelta(kv as never, [node("n1")], [] as GraphEdge[], ["obs_1"]);

    const oversized = warnCalls().filter(([msg]) => msg === "Graph write over 8 MiB");
    expect(oversized).toHaveLength(1);
    const fields = oversized[0]![1] as Record<string, unknown>;
    expect(fields.scope).toBe(KV.graphSnapshot);
    expect(fields.key).toBe("current");
    // Read the written value back and re-measure it: the logged number must
    // be the payload that went to the SDK, not an estimate.
    expect(fields.bytes).toBe(payloadByteLength(snapshotPayload(kv)));
    expect(fields.bytes as number).toBeGreaterThan(WARN_BYTES);
    expect(fields.topNodes).toBe(2);
  });

  it("stays silent under 8 MiB and reports one bounded summary per call", async () => {
    const kv = mockKV();

    await persistGraphDelta(kv as never, [node("n1")], [] as GraphEdge[], ["obs_1"]);

    expect(warnCalls()).toHaveLength(0);
    const summaries = summaryCalls();
    expect(summaries).toHaveLength(1);
    const fields = summaries[0]![1] as Record<string, unknown>;
    // One new node is a node row, a name-index entry, a degree counter, and
    // the snapshot: four writes across four scopes. Per-scope, not per-write,
    // so the line is bounded by the schema rather than by the batch.
    expect(fields.writes).toBe(4);
    const byScope = fields.byScope as Record<string, { writes: number; bytes: number }>;
    expect(Object.keys(byScope).sort()).toEqual(
      [KV.graphNodes, KV.graphNameIndex, KV.graphNodeDegree, KV.graphSnapshot].sort(),
    );
    expect(byScope[KV.graphSnapshot]!.bytes).toBe(payloadByteLength(snapshotPayload(kv)));
    expect(fields.bytes).toBe(
      Object.values(byScope).reduce((sum, s) => sum + s.bytes, 0),
    );
    expect(fields.error).toBeUndefined();
  });

  it("logs the failing write's bytes even when state::set never returns", async () => {
    const kv = mockKV();
    await kv.set(KV.graphSnapshot, "current", bigSnapshot());
    const realSet = kv.set;
    // The production shape: the socket drops under the frame and the SDK
    // reports the invocation timeout 30 s later. The write itself is lost.
    kv.set = async (scope, key, value) => {
      if (scope === KV.graphSnapshot) {
        throw new Error("Invocation timeout after 30000ms: state::set");
      }
      return realSet(scope, key, value);
    };

    await expect(
      persistGraphDelta(kv as never, [node("n1")], [] as GraphEdge[], ["obs_1"]),
    ).rejects.toThrow("Invocation timeout after 30000ms: state::set");

    const oversized = warnCalls().filter(([msg]) => msg === "Graph write over 8 MiB");
    expect(oversized).toHaveLength(1);
    expect((oversized[0]![1] as Record<string, unknown>).bytes as number).toBeGreaterThan(
      WARN_BYTES,
    );

    const summaries = summaryCalls();
    expect(summaries).toHaveLength(1);
    const fields = summaries[0]![1] as Record<string, unknown>;
    expect(fields.error).toBe("Invocation timeout after 30000ms: state::set");
    const failed = fields.failed as Record<string, unknown>;
    expect(failed.scope).toBe(KV.graphSnapshot);
    expect(failed.bytes as number).toBeGreaterThan(WARN_BYTES);
    // The three row writes before the snapshot still landed and are counted.
    expect(fields.writes).toBe(4);
  });
});
