import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction, persistGraphDelta } from "../src/functions/graph.js";
import { registerCascadeFunction } from "../src/functions/cascade.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import {
  resolveObservationIds,
  resetProvenanceWarningsForTests,
} from "../src/functions/graph-provenance.js";
import type {
  CompressedObservation,
  GraphBatch,
  GraphEdge,
  GraphNode,
  Memory,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

// U3 of the memory-reduction ladder. Every LLM-extracted node and edge used to
// carry the whole batch's observation ids, and every merge unioned those lists
// forever, so bytes per row grew N times M. A row now carries one batch id and
// the observation ids live in one row per batch.
//
// The contract that matters is R10: a reader must not be able to tell which
// shape a row was written in. Every assertion here that compares batch mode to
// legacy mode is a comparison of what the READER sees, because that is the
// property a flag flip back to legacy depends on.

const mockProvider = {
  name: "test",
  compress: vi.fn().mockResolvedValue(`<entities>
<entity type="file" name="src/a.ts"/>
<entity type="function" name="run"/>
</entities>
<relationships>
<relationship type="uses" source="src/a.ts" target="run" weight="0.9"/>
</relationships>`),
  summarize: vi.fn(),
};

// Structured fields left empty so the heuristic pass contributes nothing and
// only the LLM path -- the one that batches -- is under test.
const obs = (id: string): CompressedObservation => ({
  id,
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: `Edit ${id}`,
  facts: [],
  narrative: "",
  concepts: [],
  files: [],
  importance: 5,
});

type Row = { id: string; sourceObservationIds: string[]; sourceBatchIds?: string[] };

let sdk: ReturnType<typeof mockSdk>;
let kv: ReturnType<typeof mockKV>;
const ORIG = {
  extraction: process.env["GRAPH_EXTRACTION_ENABLED"],
  mode: process.env["GRAPH_PROVENANCE_MODE"],
};

const setMode = (mode: "batch" | "legacy" | undefined) => {
  if (mode === undefined) delete process.env["GRAPH_PROVENANCE_MODE"];
  else process.env["GRAPH_PROVENANCE_MODE"] = mode;
};

beforeEach(() => {
  sdk = mockSdk({ looseTrigger: true });
  kv = mockKV();
  vi.clearAllMocks();
  resetProvenanceWarningsForTests();
  process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
  registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  registerCascadeFunction(sdk as never, kv as never);
});

afterEach(() => {
  if (ORIG.extraction === undefined) delete process.env["GRAPH_EXTRACTION_ENABLED"];
  else process.env["GRAPH_EXTRACTION_ENABLED"] = ORIG.extraction;
  setMode(ORIG.mode as "batch" | "legacy" | undefined);
});

const rows = async <T extends Row>(scope: string) => kv.list<T>(scope);

describe("writers under GRAPH_PROVENANCE_MODE", () => {
  it("batch: one batch row per extraction, rows carry the id and no observation ids", async () => {
    setMode("batch");
    await sdk.trigger("mem::graph-extract", {
      observations: [obs("o1"), obs("o2"), obs("o3")],
    });

    const batches = await rows<GraphBatch & Row>("mem:graph:batches");
    expect(batches).toHaveLength(1);
    expect(batches[0]!.observationIds).toEqual(["o1", "o2", "o3"]);

    const nodes = await rows<GraphNode>("mem:graph:nodes");
    const edges = await rows<GraphEdge>("mem:graph:edges");
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    for (const r of [...nodes, ...edges]) {
      expect(r.sourceBatchIds).toEqual([batches[0]!.id]);
      expect(r.sourceObservationIds).toEqual([]);
    }
  });

  it("batch: merging a second extraction unions batch ids and leaves the observation list empty", async () => {
    setMode("batch");
    await sdk.trigger("mem::graph-extract", { observations: [obs("o1")] });
    await sdk.trigger("mem::graph-extract", { observations: [obs("o2")] });

    const batches = await rows<GraphBatch & Row>("mem:graph:batches");
    const nodes = await rows<GraphNode>("mem:graph:nodes");
    expect(batches).toHaveLength(2);
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.sourceBatchIds).toHaveLength(2);
      expect(new Set(n.sourceBatchIds)).toEqual(new Set(batches.map((b) => b.id)));
      expect(n.sourceObservationIds).toEqual([]);
    }
  });

  it("legacy: the same inputs produce today's arrays and no batch row", async () => {
    setMode("legacy");
    await sdk.trigger("mem::graph-extract", {
      observations: [obs("o1"), obs("o2"), obs("o3")],
    });

    expect(await rows("mem:graph:batches")).toEqual([]);
    for (const r of [
      ...(await rows<GraphNode>("mem:graph:nodes")),
      ...(await rows<GraphEdge>("mem:graph:edges")),
    ]) {
      expect(r.sourceObservationIds).toEqual(["o1", "o2", "o3"]);
      expect(r.sourceBatchIds).toBeUndefined();
    }
  });

  it("defaults to legacy when the flag is unset", async () => {
    setMode(undefined);
    await sdk.trigger("mem::graph-extract", { observations: [obs("o1")] });
    expect(await rows("mem:graph:batches")).toEqual([]);
  });

  it("the heuristic path keeps per-observation ids in batch mode", async () => {
    setMode("batch");
    const withFiles: CompressedObservation = {
      ...obs("o9"),
      files: ["src/z.ts"],
      concepts: ["zed"],
    };
    await sdk.trigger("mem::graph-extract", { observations: [withFiles] });

    const heuristic = (await rows<GraphNode>("mem:graph:nodes")).filter(
      (n) => n.name === "src/z.ts" || n.name === "zed",
    );
    expect(heuristic.length).toBeGreaterThan(0);
    for (const n of heuristic) {
      expect(n.sourceObservationIds).toEqual(["o9"]);
      expect(n.sourceBatchIds).toBeUndefined();
    }
  });
});

describe("readers resolve both shapes regardless of the flag (R10)", () => {
  it("a node written in batch mode resolves to its batch's ids with the flag back at legacy", async () => {
    setMode("batch");
    await sdk.trigger("mem::graph-extract", {
      observations: [obs("o1"), obs("o2"), obs("o3")],
    });
    setMode("legacy");

    for (const n of await rows<GraphNode>("mem:graph:nodes")) {
      expect(await resolveObservationIds(kv as never, n)).toEqual(["o1", "o2", "o3"]);
    }
  });

  it("retrieval emits the same ids in the same order from either shape", async () => {
    // Two graphs with identical content, one written each way.
    setMode("legacy");
    await sdk.trigger("mem::graph-extract", {
      observations: [obs("o1"), obs("o2"), obs("o3")],
    });
    const legacy = await new GraphRetrieval(kv as never).searchByEntities(["run"]);

    kv = mockKV();
    sdk = mockSdk({ looseTrigger: true });
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
    setMode("batch");
    await sdk.trigger("mem::graph-extract", {
      observations: [obs("o1"), obs("o2"), obs("o3")],
    });
    const batch = await new GraphRetrieval(kv as never).searchByEntities(["run"]);

    expect(batch.map((r) => r.obsId)).toEqual(legacy.map((r) => r.obsId));
    expect(batch.map((r) => r.obsId)).toEqual(["o1", "o2", "o3"]);
  });

  it("cascade flags every row carrying the overlapping batch and none carrying only another", async () => {
    setMode("batch");
    await sdk.trigger("mem::graph-extract", { observations: [obs("o1"), obs("o2")] });
    // Different XML so this extraction produces disjoint rows.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file" name="src/other.ts"/>
</entities><relationships></relationships>`);
    await sdk.trigger("mem::graph-extract", { observations: [obs("o8")] });

    const memory: Memory = {
      id: "mem_old",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "old",
      content: "",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["o2"],
    };
    await kv.set("mem:memories", memory.id, memory);

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old",
    })) as { flagged: { nodes: number; edges: number } };

    // Batch A holds o1,o2 and produced 2 nodes + 1 edge; batch B holds o8 and
    // produced 1 node. Only A overlaps.
    expect(result.flagged).toEqual({ nodes: 2, edges: 1, siblingMemories: 0 });
    const other = (await rows<GraphNode>("mem:graph:nodes")).find(
      (n) => n.name === "src/other.ts",
    );
    expect(other?.stale).toBeUndefined();
  });

  it("cascade flags the same set from batch rows as from legacy rows", async () => {
    const memory: Memory = {
      id: "mem_old",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "old",
      content: "",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["o2"],
    };

    const run = async (mode: "batch" | "legacy") => {
      kv = mockKV();
      sdk = mockSdk({ looseTrigger: true });
      registerGraphFunction(sdk as never, kv as never, mockProvider as never);
      registerCascadeFunction(sdk as never, kv as never);
      setMode(mode);
      await sdk.trigger("mem::graph-extract", {
        observations: [obs("o1"), obs("o2"), obs("o3")],
      });
      await kv.set("mem:memories", memory.id, memory);
      return (await sdk.trigger("mem::cascade-update", {
        supersededMemoryId: "mem_old",
      })) as { flagged: unknown };
    };

    expect((await run("batch")).flagged).toEqual((await run("legacy")).flagged);
  });

  it("a missing batch row resolves to no ids, logs once, and does not throw", async () => {
    const { logger } = await import("../src/logger.js");
    const node: GraphNode = {
      id: "n1",
      type: "concept",
      name: "x",
      properties: {},
      sourceObservationIds: ["inline"],
      sourceBatchIds: ["gb_missing"],
      createdAt: "2026-01-01T00:00:00Z",
    };

    expect(await resolveObservationIds(kv as never, node)).toEqual(["inline"]);
    expect(await resolveObservationIds(kv as never, node)).toEqual(["inline"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("cascade on a refused graph returns success with zero flagged and a warning", async () => {
    // A snapshot marked reset with rows on disk is exactly the orphaned state
    // the guard refuses to enumerate.
    await kv.set("mem:graph:nodes", "n1", {
      id: "n1",
      type: "concept",
      name: "x",
      properties: {},
      sourceObservationIds: ["o2"],
      createdAt: "2026-01-01T00:00:00Z",
    });
    await kv.set("mem:graph:snapshot", "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: { totalNodes: 0, totalEdges: 0, nodesByType: {}, edgesByType: {} },
      updatedAt: "2026-01-01T00:00:00Z",
      resetAt: "2026-01-01T00:00:00Z",
      dirty: false,
    });
    await kv.set("mem:memories", "mem_old", {
      id: "mem_old",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "old",
      content: "",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["o2"],
    });

    const result = (await sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old",
    })) as { success: boolean; flagged: { nodes: number }; warning?: string };

    expect(result.success).toBe(true);
    expect(result.flagged.nodes).toBe(0);
    expect(result.warning).toContain("refused");
    // The row was not touched: the old code would have kv.list'ed and flagged it.
    const n = await kv.get<GraphNode>("mem:graph:nodes", "n1");
    expect(n?.stale).toBeUndefined();
  });
});

describe("snapshot topEdges is capped", () => {
  it("evicts the lowest-weight edge when full and keeps the array at the cap", async () => {
    // Build a graph where every node is a top node, so every edge qualifies
    // for topEdges, then push past the cap.
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 3; i++) {
      nodes.push({
        id: `n${i}`,
        type: "concept",
        name: `c${i}`,
        properties: {},
        sourceObservationIds: ["o"],
        createdAt: "2026-01-01T00:00:00Z",
      });
    }
    await persistGraphDelta(kv as never, nodes, [], ["o"]);

    const CAP = 1000;
    const edges: GraphEdge[] = [];
    for (let i = 0; i < CAP + 5; i++) {
      edges.push({
        id: `e${i}`,
        // Distinct (src,tgt,type) per edge so none dedupe on the edge key.
        type: (["uses", "imports", "modifies", "causes", "fixes", "depends_on", "related_to"] as const)[i % 7]!,
        sourceNodeId: `n${i % 3}`,
        targetNodeId: `n${(i + 1 + Math.floor(i / 21)) % 3}`,
        // Weight rises with i, so the earliest edges are the lowest and get evicted.
        weight: (i % 997) / 1000,
        sourceObservationIds: ["o"],
        createdAt: "2026-01-01T00:00:00Z",
      });
    }
    await persistGraphDelta(kv as never, edges.slice(0, CAP), [], ["o"]);
    await persistGraphDelta(kv as never, [], edges.slice(CAP), ["o"]);

    const snap = await kv.get<{ topEdges: GraphEdge[] }>("mem:graph:snapshot", "current");
    expect(snap!.topEdges.length).toBeLessThanOrEqual(CAP);
  });
});
