import { createGraphIndexState } from "./helpers/graph-index-state.js";
import { initializeGraphIndex } from "../src/state/graph-retrieval-index.js";
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import { mockSdk } from "./helpers/mocks.js";
import type { GraphNode, MemoryProvider } from "../src/types.js";

const node: GraphNode = {
  id: "n1", type: "concept", name: "n1", properties: {},
  sourceObservationIds: [], createdAt: "2026-10-30T00:00:00.000Z",
};

// mem::graph-snapshot-rebuild reads the snapshot first and, past that
// pre-flight, calls kv.list on the node and edge scopes with no size check.
// A failed pre-flight means the size is unknown, so it must refuse before the
// list rather than fall through to it.
async function rig(snapshotRead: "throws" | "ok" = "ok") {
  const state = createGraphIndexState();
  await initializeGraphIndex(state.kv, { status: "ready" });
  await state.kv.set(KV.graphNodes, node.id, node);
  const sdk = mockSdk();
  registerGraphFunction(sdk as never, state.kv, {} as MemoryProvider);
  state.calls.length = 0;
  if (snapshotRead === "throws") {
    state.intercept(async (id, payload) => {
      if (id === "state::get" && String(payload.scope).startsWith(KV.graphSnapshot)) {
        throw new Error("state::get timed out");
      }
    });
  }
  const rebuild = (data?: { force?: boolean }) =>
    sdk.trigger("mem::graph-snapshot-rebuild", data) as Promise<Record<string, unknown>>;
  // collectAll pages a scope through state::list_keys plus gets (#1636); a
  // plain kv.list still goes through state::list. Either one is an enumeration.
  const graphLists = () =>
    state.calls.filter(
      (c) =>
        (c.id === "state::list" || c.id === "state::list_keys") &&
        (c.scope.startsWith(KV.graphNodes) || c.scope.startsWith(KV.graphEdges)),
    );
  return { ...state, rebuild, graphLists };
}

describe("mem::graph-snapshot-rebuild pre-flight", () => {
  it("refuses with a reason when the pre-flight read throws, and lists nothing", async () => {
    const r = await rig("throws");
    const result = await r.rebuild();
    expect(result).toMatchObject({ success: false, preflightFailed: true });
    expect(String(result.error)).toContain("state::get timed out");
    expect(r.graphLists()).toEqual([]);
  });

  it("does not let force bypass a failed pre-flight read", async () => {
    const r = await rig("throws");
    const result = await r.rebuild({ force: true });
    expect(result).toMatchObject({ success: false, preflightFailed: true });
    expect(r.graphLists()).toEqual([]);
    expect(r.calls.filter((c) => (c.id === "state::set" || c.id === "state::update") && c.scope.startsWith(KV.graphSnapshot))).toEqual([]);
  });

  it("keeps upstream behavior with no snapshot and no force", async () => {
    const r = await rig();
    const result = await r.rebuild();
    expect(result).toMatchObject({ success: false, legacyCorpus: true });
    expect(result.preflightFailed).toBeUndefined();
    expect(r.graphLists()).toEqual([]);
  });

  it("still rebuilds with force when the snapshot is absent", async () => {
    const r = await rig();
    const result = await r.rebuild({ force: true });
    expect(result).toMatchObject({ success: true, totalNodes: 1 });
    expect(r.graphLists().length).toBeGreaterThan(0);
  });

  it("treats an unknown snapshot version as absent, so force can still recover it", async () => {
    const r = await rig();
    await r.kv.set(KV.graphSnapshot, "current", { version: 99 });
    expect(await r.rebuild()).toMatchObject({ success: false, legacyCorpus: true });
    const forced = await r.rebuild({ force: true });
    expect(forced).toMatchObject({ success: true, totalNodes: 1 });
    expect(await r.kv.get(KV.graphSnapshot, "current")).toMatchObject({ version: 1 });
  });
});
