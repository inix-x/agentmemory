import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  isConsolidationEnabled: vi.fn(() => true),
}));

import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { isConsolidationEnabled } from "../src/config.js";
import { KV } from "../src/state/schema.js";
import type { SessionSummary } from "../src/types.js";

type Store = Map<string, Map<string, unknown>>;

function detach<T>(value: T): T {
  return value && typeof value === "object" ? structuredClone(value) : value;
}

function mockKV(store: Store) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const found = store.get(scope)?.get(key);
      return found === undefined ? null : detach(found as T);
    },
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
      return entries ? (Array.from(entries.values()).map((v) => detach(v)) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeSummary(i: number): SessionSummary {
  return {
    sessionId: `ses_${i}`,
    project: "test-project",
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    title: `Session ${i} summary`,
    narrative: `Worked on feature ${i}`,
    keyDecisions: [`Decision ${i}`],
    filesModified: [`src/file${i}.ts`],
    concepts: ["typescript", "testing"],
    observationCount: 5,
  };
}

describe("Consolidation run exclusion", () => {
  let store: Store;
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    store = new Map();
    sdk = mockSdk();
    kv = mockKV(store);
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  /**
   * Holds the first summarize call open so a second invocation lands while the
   * first run is genuinely mid-flight. Later calls return at once, so an
   * unguarded second run finishes and shows up as a second summarize rather
   * than as a deadlock — the overlap has to be legible in the failure.
   */
  function gatedProvider() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { started: 0, release: () => release() };
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        state.started++;
        if (state.started === 1) await gate;
        return `<facts><fact confidence="0.9">A fact</fact></facts>`;
      }),
    };
    return { provider, state };
  }

  async function seedSummaries() {
    for (let i = 0; i < 6; i++) {
      await kv.set(KV.summaries, `ses_${i}`, makeSummary(i));
    }
  }

  it("turns away a second invocation while a run is in flight", async () => {
    const { provider, state } = gatedProvider();
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedSummaries();

    const first = sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });
    await vi.waitFor(() => expect(state.started).toBe(1));

    const second = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { skipped?: boolean; reason?: string };

    // This is the assertion that names the production bug: a second run must
    // not have reached the tier at all.
    expect(state.started).toBe(1);
    expect(second.skipped).toBe(true);
    expect(second.reason).toContain("already in flight");

    state.release();
    const firstResult = (await first) as { success: boolean };

    // Asserting only "second skipped" would also pass if no run ever started,
    // so the first run's own completion has to be asserted beside it.
    expect(firstResult.success).toBe(true);
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("releases the guard once a run finishes, so the next run proceeds", async () => {
    const { provider, state } = gatedProvider();
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedSummaries();

    state.release();
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    // A guard never released turns the pipeline into a one-shot that runs at
    // boot and never again.
    expect(state.started).toBe(2);
  });

  it("releases the guard when a run throws", async () => {
    let calls = 0;
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        calls++;
        throw new Error("provider exploded");
      }),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedSummaries();

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    expect(calls).toBe(2);
  });

  it("two invocations dispatched in the same tick cannot both start a run", async () => {
    let started = 0;
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        started++;
        return `<facts><fact confidence="0.9">A fact</fact></facts>`;
      }),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedSummaries();

    // Nothing is awaited between the two dispatches. The guard has to be
    // claimed before the handler's first await, or the event loop interleaves
    // them and a check that yields first is not a guard at all.
    const [a, b] = (await Promise.all([
      sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" }),
      sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" }),
    ])) as Array<{ skipped?: boolean }>;

    expect(started).toBe(1);
    expect([a!.skipped, b!.skipped].filter(Boolean).length).toBe(1);
  });

  it("force bypasses the enabled gate but not the exclusion", async () => {
    const { provider, state } = gatedProvider();
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedSummaries();

    const first = sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });
    await vi.waitFor(() => expect(state.started).toBe(1));

    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const forced = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      force: true,
    })) as { skipped?: boolean; reason?: string };

    // force gets past CONSOLIDATION_ENABLED, and then the exclusion holds it.
    expect(forced.skipped).toBe(true);
    expect(forced.reason).toContain("already in flight");
    expect(forced.reason).not.toContain("CONSOLIDATION_ENABLED");
    expect(state.started).toBe(1);

    state.release();
    await first;
  });
});
