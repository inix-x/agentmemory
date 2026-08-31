import { describe, expect, it, vi } from "vitest";
import type { Session } from "../src/types.js";
import { registerSessionSweepFunction } from "../src/functions/session-sweep.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Store = Map<string, Map<string, unknown>>;
type Handler = (payload: unknown) => unknown | Promise<unknown>;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    // Comfortably past the 1440-minute (one day) default threshold.
    startedAt: minutesAgo(3000),
    updatedAt: minutesAgo(3000),
    status: "active",
    observationCount: 1,
    ...overrides,
  };
}

function mockKV(store: Store) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

/**
 * Stands in for the two lifecycle functions the sweep fans out to.
 * `event::session::ended` mutates the stored session the way the real handler
 * does, so assertions can read terminal state out of the store.
 */
function mockSdk(
  store: Store,
  opts: { endFails?: boolean; stoppedFails?: boolean } = {},
) {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ function_id: string; payload: unknown }> = [];

  handlers.set("event::session::ended", async (payload) => {
    if (opts.endFails) throw new Error("ended trigger failed");
    const { sessionId, endedAt } = payload as {
      sessionId: string;
      endedAt?: string;
    };
    const session = store.get(KV.sessions)?.get(sessionId) as Session;
    if (session) {
      session.status = "completed";
      // Mirrors src/triggers/events.ts: caller-supplied endedAt wins.
      session.endedAt = endedAt ?? new Date().toISOString();
    }
    return { success: true };
  });
  handlers.set("event::session::stopped", async () => {
    if (opts.stoppedFails) throw new Error("stopped trigger failed");
    return { success: true };
  });

  return {
    calls,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

function storeWith(sessions: Session[]): Store {
  const store: Store = new Map();
  const sessionMap = new Map<string, unknown>();
  for (const s of sessions) sessionMap.set(s.id, s);
  store.set(KV.sessions, sessionMap);
  return store;
}

async function runSweep(
  store: Store,
  payload: Record<string, unknown> = {},
  opts: { endFails?: boolean; stoppedFails?: boolean } = {},
) {
  const { sdk, calls } = mockSdk(store, opts);
  registerSessionSweepFunction(sdk as never, mockKV(store) as never);
  const result = (await sdk.trigger({
    function_id: "mem::session-sweep",
    payload,
  })) as { candidates: number; swept: number; dryRun: boolean };
  return { result, calls };
}

describe("mem::session-sweep", () => {
  it("completes a session idle past the threshold", async () => {
    const store = storeWith([makeSession("ses_idle")]);

    const { result } = await runSweep(store);

    expect(result.swept).toBe(1);
    const session = store.get(KV.sessions)!.get("ses_idle") as Session;
    expect(session.status).toBe("completed");
    expect(session.endedAt).toBeTruthy();
  });

  it("leaves a recently active session alone", async () => {
    const store = storeWith([
      makeSession("ses_fresh", { updatedAt: minutesAgo(5) }),
    ]);

    const { result } = await runSweep(store);

    expect(result.candidates).toBe(0);
    expect(result.swept).toBe(0);
    expect((store.get(KV.sessions)!.get("ses_fresh") as Session).status).toBe(
      "active",
    );
  });

  it("ignores sessions that are already completed", async () => {
    const store = storeWith([
      makeSession("ses_done", { status: "completed" }),
      makeSession("ses_abandoned", { status: "abandoned" }),
    ]);

    const { result } = await runSweep(store);

    expect(result.candidates).toBe(0);
    expect(result.swept).toBe(0);
  });

  it("ages a session by startedAt when updatedAt is absent", async () => {
    // Sessions created by POST /session/start carry no updatedAt until their
    // first observation lands, so the fallback has to hold.
    const store = storeWith([
      makeSession("ses_no_updated", { updatedAt: undefined }),
    ]);

    const { result } = await runSweep(store);

    expect(result.swept).toBe(1);
  });

  it("skips a session whose timestamps cannot be parsed", async () => {
    const store = storeWith([
      makeSession("ses_bad", {
        startedAt: "not-a-date",
        updatedAt: undefined,
      }),
    ]);

    const { result } = await runSweep(store);

    expect(result.candidates).toBe(0);
    expect((store.get(KV.sessions)!.get("ses_bad") as Session).status).toBe(
      "active",
    );
  });

  it("counts candidates but changes nothing on a dry run", async () => {
    const store = storeWith([makeSession("ses_idle")]);

    const { result, calls } = await runSweep(store, { dryRun: true });

    expect(result.candidates).toBe(1);
    expect(result.swept).toBe(0);
    expect((store.get(KV.sessions)!.get("ses_idle") as Session).status).toBe(
      "active",
    );
    expect(calls.some((c) => c.function_id === "event::session::ended")).toBe(
      false,
    );
  });

  it("honours an idleMinutes override from the payload", async () => {
    const store = storeWith([
      makeSession("ses_recent", { updatedAt: minutesAgo(30) }),
    ]);

    const untouched = await runSweep(store, { idleMinutes: 120 });
    expect(untouched.result.swept).toBe(0);

    const swept = await runSweep(store, { idleMinutes: 10 });
    expect(swept.result.swept).toBe(1);
  });

  it("caps how many sessions one run ends", async () => {
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession(`ses_${i}`),
    );
    const store = storeWith(sessions);

    const { result } = await runSweep(store);

    // Default maxPerRun is 25; every idle session is still counted.
    expect(result.candidates).toBe(30);
    expect(result.swept).toBe(25);
  });

  it.each([
    ["NaN", NaN],
    ["zero", 0],
    ["negative", -120],
    ["non-numeric", "10" as unknown as number],
  ])(
    "falls back to the default threshold when idleMinutes is %s",
    async (_label, bad) => {
      // A bad override must not widen the net. At the 60m default a session
      // idle 30m is not a candidate; a negative or zero threshold would sweep
      // every active session.
      const store = storeWith([
        makeSession("ses_recent", { updatedAt: minutesAgo(30) }),
      ]);

      const { result } = await runSweep(store, { idleMinutes: bad });

      expect(result.candidates).toBe(0);
      expect((store.get(KV.sessions)!.get("ses_recent") as Session).status).toBe(
        "active",
      );
    },
  );

  it("writes an audit entry for each swept session", async () => {
    const store = storeWith([makeSession("ses_idle")]);

    await runSweep(store);

    const audit = Array.from(store.get(KV.audit)?.values() ?? []) as Array<{
      operation: string;
      functionId: string;
      targetIds: string[];
    }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.operation).toBe("session_sweep");
    expect(audit[0]!.functionId).toBe("mem::session-sweep");
    expect(audit[0]!.targetIds).toEqual(["ses_idle"]);
  });

  it("does not audit on a dry run", async () => {
    const store = storeWith([makeSession("ses_idle")]);

    await runSweep(store, { dryRun: true });

    expect(store.get(KV.audit)?.size ?? 0).toBe(0);
  });

  it("fans out a summary with consolidation suppressed", async () => {
    const store = storeWith([makeSession("ses_idle")]);

    const { calls } = await runSweep(store);

    const stopped = calls.find(
      (c) => c.function_id === "event::session::stopped",
    );
    expect(stopped).toBeTruthy();
    expect(stopped!.payload).toEqual({
      sessionId: "ses_idle",
      skipConsolidation: true,
    });
  });

  it("leaves a session sitting exactly on the threshold alone", async () => {
    // The comparison is `<=`, so equality must NOT sweep. Without this the
    // boundary is untested and `<=` vs `<` is a silent change.
    const store = storeWith([makeSession("ses_edge")]);
    const session = store.get(KV.sessions)!.get("ses_edge") as Session;
    const idleMinutes = 90;
    session.updatedAt = new Date(
      Date.now() - idleMinutes * 60 * 1000,
    ).toISOString();

    const { result } = await runSweep(store, { idleMinutes });

    expect(result.candidates).toBe(0);
    expect(session.status).toBe("active");
  });

  it("records the last activity as endedAt, not the sweep time", async () => {
    const store = storeWith([makeSession("ses_idle")]);
    const before = store.get(KV.sessions)!.get("ses_idle") as Session;
    const lastSeen = before.updatedAt;

    await runSweep(store);

    const session = store.get(KV.sessions)!.get("ses_idle") as Session;
    expect(session.endedAt).toBe(lastSeen);
  });

  it("survives a rejected summary fan-out", async () => {
    // The fan-out is deliberately not awaited, so its rejection must be caught
    // or it surfaces as an unhandled rejection.
    const store = storeWith([makeSession("ses_idle")]);

    const { result } = await runSweep(store, {}, { stoppedFails: true });

    expect(result.swept).toBe(1);
    expect((store.get(KV.sessions)!.get("ses_idle") as Session).status).toBe(
      "completed",
    );
  });

  it("caps attempts, not successes, when every end fails", async () => {
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession(`ses_${i}`),
    );
    const store = storeWith(sessions);

    const { calls } = await runSweep(store, {}, { endFails: true });

    // Without an attempt-based cap a failing backlog retries the whole list.
    const endCalls = calls.filter(
      (c) => c.function_id === "event::session::ended",
    );
    expect(endCalls).toHaveLength(25);
  });

  it("keeps sweeping after one session fails to end", async () => {
    const store = storeWith([makeSession("ses_a"), makeSession("ses_b")]);

    const { result } = await runSweep(store, {}, { endFails: true });

    expect(result.candidates).toBe(2);
    expect(result.swept).toBe(0);
    expect((store.get(KV.sessions)!.get("ses_b") as Session).status).toBe(
      "active",
    );
  });
});
