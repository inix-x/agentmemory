import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// U1 of the memory-reduction ladder. Every observation used to be written into
// the stream store twice more than anything reads: once raw and once compressed,
// both into STREAM.group(sessionId). Nothing in src/ ever read that group -- the
// viewer connects to `/stream/mem-live/viewer` (src/viewer/index.html:1099) and
// subscribes to the viewer group alone -- so those writes were resident bytes
// with no consumer, on the hottest path in the service.
//
// The assertion that matters is the negative one: zero writes into a session
// group. It is checked by recording every trigger the function fires, because
// the failure mode is a call site that was missed rather than one that errors.

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

type RecordedTrigger = { function_id: string; payload: Record<string, unknown> };

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggers: RecordedTrigger[] = [];
  return {
    fns,
    triggers,
    registerFunction: (idOrOpts: string | { id: string }, fn: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      triggers.push({
        function_id: id,
        payload: (payload ?? {}) as Record<string, unknown>,
      });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function hookPayload(sessionId: string) {
  return {
    sessionId,
    project: "/home/user/repo",
    cwd: "/home/user/repo",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: { tool_name: "Bash", tool_input: "ls" },
  };
}

function seedSession(kv: ReturnType<typeof mockKV>, sessionId: string) {
  if (!kv.store.has("mem:sessions")) kv.store.set("mem:sessions", new Map());
  kv.store.get("mem:sessions")!.set(sessionId, {
    id: sessionId,
    project: "/home/user/repo",
    cwd: "/home/user/repo",
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "active",
    observationCount: 0,
  });
}

const streamWrites = (t: RecordedTrigger[]) =>
  t.filter((x) => x.function_id.startsWith("stream::"));

describe("observe writes nothing into a per-session stream group", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("records no stream::set and one viewer stream::send on the raw path", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const sid = "ses_raw";
    seedSession(kv, sid);
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", hookPayload(sid))) as {
      observationId?: string;
    };

    expect(result.observationId).toBeTruthy();
    const streams = streamWrites(sdk.triggers);
    // Every stream write is a send, and every one is addressed to the viewer.
    // With auto-compress off the synthetic path runs too, so one /observe
    // produces two viewer sends -- raw and compressed -- and zero session-group
    // writes, down from four writes per observation.
    expect(streams.map((s) => s.function_id)).toEqual([
      "stream::send",
      "stream::send",
    ]);
    expect(streams.map((s) => s.payload["group_id"])).not.toContain(sid);
    expect(new Set(streams.map((s) => s.payload["group_id"]))).toEqual(
      new Set(["viewer"]),
    );
  });

  it("sends the synthetic compressed observation to the viewer, not a session group", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const sid = "ses_synthetic";
    seedSession(kv, sid);
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", hookPayload(sid));

    const streams = streamWrites(sdk.triggers);
    // Raw send plus synthetic compressed send, both to the viewer group.
    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.function_id)).toEqual([
      "stream::send",
      "stream::send",
    ]);
    expect(streams.map((s) => s.payload["group_id"])).toEqual([
      "viewer",
      "viewer",
    ]);

    const compressed = streams[1]!;
    expect(compressed.payload["type"]).toBe("compressed_observation");
    const data = compressed.payload["data"] as Record<string, unknown>;
    expect(data["type"]).toBe("compressed");
    expect(data["sessionId"]).toBe(sid);
    expect(data["observation"]).toBeTruthy();
  });

  it("keeps the session-group write out of the store scope too", async () => {
    // A stream write lands in the engine's stream store, not KV -- but a call
    // site that was converted to kv.set instead of removed would still cost the
    // resident bytes this unit exists to stop. Nothing may write a scope keyed
    // by the raw session id.
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const sid = "ses_scopes";
    seedSession(kv, sid);
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", hookPayload(sid));

    expect([...kv.store.keys()]).not.toContain(sid);
  });
});
