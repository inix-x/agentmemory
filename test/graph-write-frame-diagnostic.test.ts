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

// A 9 MiB row. It used to be a 9 MiB snapshot, which the byte bound now shrinks
// before the write, so the oversized write has to come from a row instead. Rows
// are unbounded by design: production's largest node on disk is 572,956 bytes
// and nothing stops one growing further, which is why the guard covers them.
function fatNode(): GraphNode {
  return {
    ...node("hub"),
    properties: { blob: "x".repeat(9 * 1024 * 1024) },
  };
}

const nodePayload = (kv: ReturnType<typeof mockKV>, id: string) => ({
  scope: KV.graphNodes,
  key: id,
  value: kv.store.get(KV.graphNodes)!.get(id),
});

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
  it("warns once, with the bytes state::set is handed, when a write crosses 8 MiB", async () => {
    const kv = mockKV();

    await persistGraphDelta(kv as never, [fatNode()], [] as GraphEdge[], ["obs_1"]);

    const oversized = warnCalls().filter(([msg]) => msg === "Graph write over 8 MiB");
    expect(oversized).toHaveLength(1);
    const fields = oversized[0]![1] as Record<string, unknown>;
    expect(fields.scope).toBe(KV.graphNodes);
    expect(fields.key).toBe("hub");
    // Read the written value back and re-measure it: the logged number must
    // be the payload that went to the SDK, not an estimate.
    expect(fields.bytes).toBe(payloadByteLength(nodePayload(kv, "hub")));
    expect(fields.bytes as number).toBeGreaterThan(WARN_BYTES);
    expect(fields.overFrameLimit).toBe(false);
    // The row is 9 MiB and the snapshot that cached it is not: the byte bound
    // dropped it before the snapshot write.
    const snap = kv.store.get(KV.graphSnapshot)!.get("current");
    expect(payloadByteLength(snap)).toBeLessThan(WARN_BYTES);
  });

  it("stays silent under 8 MiB and reports one bounded summary per call", async () => {
    const kv = mockKV();

    await persistGraphDelta(kv as never, [node("n1")], [] as GraphEdge[], ["obs_1"]);

    expect(warnCalls()).toHaveLength(0);
    const summaries = summaryCalls();
    expect(summaries).toHaveLength(1);
    const fields = summaries[0]![1] as Record<string, unknown>;
    // One new node is a node row, a name-index entry, a degree counter, a
    // catalog entry, an obs-index entry, and the snapshot: six writes across
    // six scopes. Per-scope, not per-write, so the line stays bounded by the
    // schema rather than by the batch, which is the property that matters here.
    expect(fields.writes).toBe(6);
    const byScope = fields.byScope as Record<string, { writes: number; bytes: number }>;
    expect(Object.keys(byScope).sort()).toEqual(
      [
        KV.graphNodes,
        KV.graphNameIndex,
        KV.graphNodeDegree,
        KV.graphNames,
        KV.graphObsIndex,
        KV.graphSnapshot,
      ].sort(),
    );
    expect(byScope[KV.graphSnapshot]!.bytes).toBe(payloadByteLength(snapshotPayload(kv)));
    expect(fields.bytes).toBe(
      Object.values(byScope).reduce((sum, s) => sum + s.bytes, 0),
    );
    expect(fields.error).toBeUndefined();
  });

  it("logs the failing write's bytes even when state::set never returns", async () => {
    const kv = mockKV();
    const realSet = kv.set;
    // The production shape: the socket drops under the frame and the SDK
    // reports the invocation timeout 30 s later. The write itself is lost.
    kv.set = async (scope, key, value) => {
      if (scope === KV.graphNodes) {
        throw new Error("Invocation timeout after 30000ms: state::set");
      }
      return realSet(scope, key, value);
    };

    await expect(
      persistGraphDelta(kv as never, [fatNode()], [] as GraphEdge[], ["obs_1"]),
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
    expect(failed.scope).toBe(KV.graphNodes);
    expect(failed.bytes as number).toBeGreaterThan(WARN_BYTES);
    // The row write is the first one this batch attempts, and it is the one
    // that threw, so it is the only one counted.
    expect(fields.writes).toBe(1);
  });
});
