import { afterEach, describe, expect, it, vi } from "vitest";
import { StateKV, applyUpdateOps } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { initializeGraphIndex } from "../src/state/graph-retrieval-index.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { CompressedObservation } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Fork-only gate: mem::graph-extract writes nothing unless
// GRAPH_WRITES_ENABLED=true. Each "off" case has an "on" twin so the
// write detector is proven to see graph writes, not just to stay quiet.

const SID = "ses_gate";
const secret = "graph-gate-test";
const auth = { authorization: `Bearer ${secret}` };

function obs(id: string, timestamp: string): CompressedObservation {
  return {
    id,
    sessionId: SID,
    timestamp,
    type: "file_edit",
    title: `edit ${id}`,
    facts: [],
    narrative: `touched src/${id}.ts`,
    concepts: ["gate-test"],
    files: [`src/${id}.ts`],
    importance: 5,
  };
}

async function rig() {
  const store = new Map<string, Map<string, unknown>>();
  const handlers = new Map<string, (data: any) => Promise<any>>();
  const writes: string[] = [];
  const lists: string[] = [];
  const rows = (scope: string) => {
    if (!store.has(scope)) store.set(scope, new Map());
    return store.get(scope)!;
  };
  const sdk = {
    registerFunction: (idOrOpts: string | { id: string }, handler: (data: any) => Promise<any>) =>
      handlers.set(typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id, handler),
    registerTrigger: () => {},
    trigger: async ({ function_id: id, payload }: { function_id: string; payload: any }): Promise<any> => {
      if (id.startsWith("state::")) {
        const { scope, key } = payload;
        if (id !== "state::get" && id !== "state::list") writes.push(scope);
        if (id === "state::list") lists.push(scope);
        if (id === "state::get") return structuredClone(rows(scope).get(key) ?? null);
        if (id === "state::list") return structuredClone([...rows(scope).values()]);
        if (id === "state::delete") { rows(scope).delete(key); return; }
        if (id === "state::set") { rows(scope).set(key, structuredClone(payload.value)); return payload.value; }
        if (id === "state::update") {
          const old_value = structuredClone(rows(scope).get(key) ?? null);
          const new_value = applyUpdateOps(old_value, payload.ops);
          rows(scope).set(key, structuredClone(new_value));
          return { old_value, new_value, errors: [] };
        }
        throw new Error(`Unexpected state operation ${id}`);
      }
      if (id === "mem::summarize") return {};
      // Side-effect fan-out (slot-reflect, consolidation) is not under test.
      return handlers.get(id)?.(payload) ?? null;
    },
  };
  const kv = new StateKV(sdk as never);
  registerGraphFunction(sdk as never, kv, { name: "noop" } as never);
  registerEventTriggers(sdk as never, kv);
  registerApiTriggers(sdk as never, kv, secret);
  await initializeGraphIndex(kv, { status: "ready" });
  await kv.set(KV.sessions, SID, { id: SID, project: "p", cwd: "/p", startedAt: "2026-10-30T00:00:00.000Z", status: "active", observationCount: 2 });
  for (const o of [obs("a", "2026-10-30T00:01:00.000Z"), obs("b", "2026-10-30T00:02:00.000Z")]) {
    await kv.set(KV.observations(SID), o.id, o);
  }
  writes.length = 0;
  lists.length = 0;
  return {
    call: (id: string, data: unknown) => handlers.get(id)!(data),
    graphWrites: () => writes.filter((s) => s.startsWith("mem:graph")),
    listedScopes: () => lists,
    session: () => store.get(KV.sessions)!.get(SID) as Record<string, unknown>,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe.each([
  ["unset", undefined],
  ["false", "false"],
])("GRAPH_WRITES_ENABLED %s", (_label, value) => {
  it("mem::graph-extract returns skipped and writes no graph scope", async () => {
    vi.stubEnv("GRAPH_WRITES_ENABLED", value);
    const r = await rig();
    const result = await r.call("mem::graph-extract", { observations: [obs("c", "2026-10-30T00:03:00.000Z")] });
    expect(result).toEqual({ success: true, skipped: true, reason: "GRAPH_WRITES_ENABLED is not set" });
    expect(r.graphWrites()).toEqual([]);
  });

  it("a session-stopped event with observations writes no graph scope", async () => {
    vi.stubEnv("GRAPH_WRITES_ENABLED", value);
    const r = await rig();
    await r.call("event::session::stopped", { sessionId: SID });
    expect(r.graphWrites()).toEqual([]);
    // The #1268 watermark still advances: observations captured while the
    // gate is off are not re-sent when it turns on (POST /graph/build is the
    // backfill path).
    expect(r.session().graphExtractedAt).toBe("2026-10-30T00:02:00.000Z");
  });

  it("POST /graph/extract returns the skipped result and writes nothing", async () => {
    vi.stubEnv("GRAPH_WRITES_ENABLED", value);
    const r = await rig();
    const res = await r.call("api::graph-extract", { headers: auth, body: { observations: [obs("c", "2026-10-30T00:03:00.000Z")] } });
    expect(res.status_code).toBe(200);
    expect(res.body).toMatchObject({ success: true, skipped: true });
    expect(r.graphWrites()).toEqual([]);
  });

  it("POST /graph/build returns the skipped result without scanning or writing", async () => {
    vi.stubEnv("GRAPH_WRITES_ENABLED", value);
    const r = await rig();
    const res = await r.call("api::graph-build", { headers: auth, body: {} });
    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({
      success: true,
      skipped: true,
      reason: "GRAPH_WRITES_ENABLED is not set",
      sessions: 0,
      batches: 0,
      nodes: 0,
      edges: 0,
    });
    expect(r.listedScopes()).toEqual([]);
    expect(r.graphWrites()).toEqual([]);
  });
});

describe("GRAPH_WRITES_ENABLED=true", () => {
  it("mem::graph-extract writes the heuristic graph as upstream does", async () => {
    vi.stubEnv("GRAPH_WRITES_ENABLED", "true");
    const r = await rig();
    const result = await r.call("mem::graph-extract", { observations: [obs("c", "2026-10-30T00:03:00.000Z")] });
    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.nodesAdded).toBeGreaterThan(0);
    expect(r.graphWrites()).toContain(KV.graphNodes);
  });

  it("a session-stopped event writes the graph", async () => {
    vi.stubEnv("GRAPH_WRITES_ENABLED", "true");
    const r = await rig();
    await r.call("event::session::stopped", { sessionId: SID });
    expect(r.graphWrites()).toContain(KV.graphNodes);
  });

  it("POST /graph/build adds nodes", async () => {
    vi.stubEnv("GRAPH_WRITES_ENABLED", "true");
    const r = await rig();
    const res = await r.call("api::graph-build", { headers: auth, body: {} });
    expect(res.body.nodes).toBeGreaterThan(0);
    expect(r.graphWrites()).toContain(KV.graphNodes);
  });
});
