import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The observation cap used to be enforced by enumerating the whole
// per-session observation scope on EVERY write, inside the per-session
// keyed lock. /observe is ~82% of production traffic, so that put an
// unbounded read on the hottest path in the service.
//
// `observationCount` is already maintained on the session record by this
// same function, so the cap can be checked from it. It is only ever an
// UPPER bound: evict.ts and remember.ts delete observations without
// decrementing it. So a count below the cap is trustworthy (skip the
// read), and a count at or above the cap is not (enumerate to confirm).
function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listCalls: string[] = [];
  return {
    store,
    listCalls,
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
      listCalls.push(scope);
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    fns,
    registerFunction: (idOrOpts: string | { id: string }, fn: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

const CAP = 500;
const OBS_SCOPE = (sid: string) => `mem:obs:${sid}`;

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

function seedSession(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  fields: Record<string, unknown>,
) {
  if (!kv.store.has("mem:sessions")) kv.store.set("mem:sessions", new Map());
  kv.store.get("mem:sessions")!.set(sessionId, {
    id: sessionId,
    project: "/home/user/repo",
    cwd: "/home/user/repo",
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "active",
    ...fields,
  });
}

function seedObservations(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  n: number,
) {
  const scope = OBS_SCOPE(sessionId);
  if (!kv.store.has(scope)) kv.store.set(scope, new Map());
  const m = kv.store.get(scope)!;
  for (let i = 0; i < n; i++) m.set(`obs_${i}`, { id: `obs_${i}` });
}

describe("observe cap check does not enumerate the session scope", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("skips the observation-scope read when observationCount is below the cap", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const sid = "ses_under_cap";
    seedSession(kv, sid, { observationCount: 12 });
    seedObservations(kv, sid, 12);
    registerObserveFunction(sdk as never, kv as never, undefined, CAP);

    const result = (await sdk.trigger("mem::observe", hookPayload(sid))) as {
      observationId?: string;
      success?: boolean;
    };

    expect(result.observationId).toBeTruthy();
    // The whole point: no full enumeration of the session's observations.
    expect(kv.listCalls).not.toContain(OBS_SCOPE(sid));
  });

  it("still rejects at the cap", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const sid = "ses_at_cap";
    seedSession(kv, sid, { observationCount: CAP });
    seedObservations(kv, sid, CAP);
    registerObserveFunction(sdk as never, kv as never, undefined, CAP);

    const result = (await sdk.trigger("mem::observe", hookPayload(sid))) as {
      success?: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/limit reached/i);
  });

  it("does not reject when the counter over-counts after eviction", async () => {
    // evict.ts:217/260 and remember.ts:283 delete observations WITHOUT
    // decrementing observationCount. Trusting the counter alone at the
    // cap boundary would lock a session out of writes forever.
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const sid = "ses_evicted";
    seedSession(kv, sid, { observationCount: CAP + 40 });
    seedObservations(kv, sid, 3); // eviction removed almost everything
    registerObserveFunction(sdk as never, kv as never, undefined, CAP);

    const result = (await sdk.trigger("mem::observe", hookPayload(sid))) as {
      observationId?: string;
      success?: boolean;
    };

    expect(result.observationId).toBeTruthy();
    expect(result.success).not.toBe(false);
    // Correctness here costs one read, and only at the boundary.
    expect(kv.listCalls).toContain(OBS_SCOPE(sid));
  });

  it("falls back to enumeration when the counter is absent (legacy session)", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const sid = "ses_legacy";
    seedSession(kv, sid, {}); // predates observationCount
    seedObservations(kv, sid, CAP);
    registerObserveFunction(sdk as never, kv as never, undefined, CAP);

    const result = (await sdk.trigger("mem::observe", hookPayload(sid))) as {
      success?: boolean;
      error?: string;
    };

    expect(kv.listCalls).toContain(OBS_SCOPE(sid));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/limit reached/i);
  });
});
