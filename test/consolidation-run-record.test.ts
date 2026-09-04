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

// Detaches on read like the pipeline mock does, so "the row was finalized" is
// distinguishable from "the caller still holds the object it wrote".
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

type RunRecord = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  triggersDuringRun: number;
  results?: Record<string, unknown>;
};

function runRows(store: Store): RunRecord[] {
  const scope = store.get(KV.consolidationRuns);
  if (!scope) return [];
  return Array.from(scope.entries())
    .filter(([key]) => key !== "current")
    .map(([, value]) => value as RunRecord);
}

function idleProvider() {
  return { name: "test", compress: vi.fn(), summarize: vi.fn() };
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

/** Seeds a run row still marked running, plus the pointer that finds it. */
async function seedRunningRow(
  kv: ReturnType<typeof mockKV>,
  runId: string,
  ageMs: number,
): Promise<void> {
  const startedAt = new Date(Date.now() - ageMs).toISOString();
  await kv.set(KV.consolidationRuns, runId, {
    runId,
    startedAt,
    status: "running",
    tier: "all",
  });
  await kv.set(KV.consolidationRuns, "current", { runId, startedAt });
}

describe("Consolidation run record", () => {
  let store: Store;
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    store = new Map();
    sdk = mockSdk();
    kv = mockKV(store);
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("a completed run finalizes its row and clears the pointer", async () => {
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      idleProvider() as never,
    );

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { runId?: string };

    const rows = runRows(store);
    expect(rows.length).toBe(1);
    expect(rows[0]!.runId).toBe(result.runId);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.finishedAt).toBeTruthy();
    // A pointer left behind would make the next trigger think a run is live.
    expect(await kv.get(KV.consolidationRuns, "current")).toBeNull();
  });

  it("a run that throws is stamped interrupted rather than left running", async () => {
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      idleProvider() as never,
    );
    // recordAudit writes through kv.set, and that call sits outside every
    // tier's own catch. Failing it makes the run throw after the row exists,
    // which is the shape a crash mid-run leaves behind.
    const realSet = kv.set;
    kv.set = (async (scope: string, key: string, data: unknown) => {
      if (scope.startsWith("mem:audit")) throw new Error("audit write failed");
      return realSet(scope, key, data as never);
    }) as typeof kv.set;

    await expect(
      sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" }),
    ).rejects.toThrow("audit write failed");

    kv.set = realSet;
    const rows = runRows(store);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("interrupted");
    expect(await kv.get(KV.consolidationRuns, "current")).toBeNull();
  });

  it("a run row left running past its lifetime is stamped interrupted, and the next run proceeds", async () => {
    // A worker death is a fresh process over the same store: the in-process
    // flag is gone, but the durable row is still marked running.
    const deadRunId = "crun_dead";
    await seedRunningRow(kv, deadRunId, 60 * 60 * 1000);

    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      idleProvider() as never,
    );

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; skipped?: boolean };

    expect(result.skipped).toBeUndefined();
    expect(result.success).toBe(true);

    const dead = await kv.get<RunRecord>(KV.consolidationRuns, deadRunId);
    expect(dead!.status).toBe("interrupted");
    expect(dead!.finishedAt).toBeTruthy();
    expect(
      runRows(store).some((r) => r.runId !== deadRunId && r.status === "completed"),
    ).toBe(true);
  });

  it("a run row still inside its lifetime skips the next invocation without stamping it", async () => {
    const liveRunId = "crun_live";
    await seedRunningRow(kv, liveRunId, 1000);

    const provider = idleProvider();
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { skipped?: boolean };

    expect(result.skipped).toBe(true);
    const live = await kv.get<RunRecord>(KV.consolidationRuns, liveRunId);
    expect(live!.status).toBe("running");
    expect(live!.finishedAt).toBeUndefined();
    expect(provider.summarize).not.toHaveBeenCalled();
    // The turned-away trigger still counts, against the row that turned it
    // away. This path crosses a process boundary, so it cannot use the
    // in-memory counter.
    expect(live!.triggersDuringRun).toBe(1);
  });

  it("keeps the run scope bounded rather than growing one row per run forever", async () => {
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      idleProvider() as never,
    );

    for (let i = 0; i < 60; i++) {
      await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });
    }

    const rows = runRows(store);
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(rows.length).toBeGreaterThan(0);
  });
  it("distinguishes a tier that skipped by policy from a tier that threw", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    // Six summaries clears the semantic precondition, so that tier reaches the
    // provider and throws. Procedural has no patterns and declines by policy.
    for (let i = 0; i < 6; i++) {
      await kv.set(KV.summaries, `ses_${i}`, makeSummary(i));
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });

    const results = runRows(store)[0]!.results as Record<
      string,
      { status?: string; reason?: string; error?: string }
    >;

    expect(results["semantic"]!.status).toBe("error");
    expect(results["semantic"]!.error).toContain("provider exploded");
    expect(results["procedural"]!.status).toBe("skipped");
    expect(results["procedural"]!.reason).toContain("fewer than 2");
    // One value carrying both meanings is the collapse this split removes.
    expect(results["semantic"]!.status).not.toBe(results["procedural"]!.status);
  });
  it("counts a burst of turned-away triggers, including those landing before the run row exists", async () => {
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
    for (let i = 0; i < 6; i++) {
      await kv.set(KV.summaries, `ses_${i}`, makeSummary(i));
    }

    // All in one tick, so every trigger after the first lands during run
    // startup, before the run row is written. Counting against the row as they
    // arrive would drop all of them.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" }),
      ),
    );

    expect(started).toBe(1);
    const rows = runRows(store);
    expect(rows.length).toBe(1);
    expect(rows[0]!.triggersDuringRun).toBe(7);
  });
});
