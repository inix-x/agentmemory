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
import { auditQueryScopes } from "../src/functions/audit.js";
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
      if (!fn) return { ok: true };
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

type RunRecord = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  results?: Record<string, { ms?: number; status?: string }>;
};

function runRow(store: Store): RunRecord {
  const scope = store.get(KV.consolidationRuns)!;
  const rows = Array.from(scope.entries())
    .filter(([key]) => key !== "current")
    .map(([, value]) => value as RunRecord);
  expect(rows.length).toBe(1);
  return rows[0]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Consolidation tier instrumentation", () => {
  let store: Store;
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    store = new Map();
    sdk = mockSdk();
    kv = mockKV(store);
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("reports a wall time for every tier, bounded by the run's own wall time", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => "<facts></facts>"),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 6; i++) {
      await kv.set(KV.summaries, `ses_${i}`, makeSummary(i));
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });

    const row = runRow(store);
    const results = row.results!;
    const tiers = ["semantic", "reflect", "procedural", "decay"];
    for (const tier of tiers) {
      expect(results[tier], `${tier} missing from the run record`).toBeDefined();
      expect(typeof results[tier]!.ms).toBe("number");
      expect(results[tier]!.ms).toBeGreaterThanOrEqual(0);
    }

    // The tiers run in sequence, so their times cannot add up to more than the
    // run did. A tier timed from the wrong start would break this.
    const runMs =
      new Date(row.finishedAt!).getTime() - new Date(row.startedAt).getTime();
    const tierMs = tiers.reduce((sum, t) => sum + (results[t]!.ms ?? 0), 0);
    expect(tierMs).toBeLessThanOrEqual(runMs);
  });

  it("attributes a slow tier to that tier and not to its neighbours", async () => {
    // The whole point of per-tier timing: "the run took 6 minutes" does not say
    // which tier to go and look at.
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        await sleep(60);
        return "<facts></facts>";
      }),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 6; i++) {
      await kv.set(KV.summaries, `ses_${i}`, makeSummary(i));
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });

    const results = runRow(store).results!;
    expect(results["semantic"]!.ms).toBeGreaterThanOrEqual(55);
    // Decay does no provider work, so it must not inherit the semantic delay.
    expect(results["decay"]!.ms).toBeLessThan(55);
  });

  it("stamps the reflect trigger time so the wait is measurable at the far side", async () => {
    // Reflect is a separate engine invocation on the same single worker. Only
    // the caller knows when it dispatched, so the far side cannot compute its
    // own wait unless the trigger time travels with the payload.
    let seen: { triggeredAtMs?: number } | undefined;
    sdk.registerFunction(
      "mem::reflect",
      async (payload: { triggeredAtMs?: number }) => {
        seen = payload;
        return { success: true, newInsights: 0, reinforced: 0 };
      },
    );
    registerConsolidationPipelineFunction(
      sdk as never,
      kv as never,
      { name: "test", compress: vi.fn(), summarize: vi.fn() } as never,
    );

    const before = Date.now();
    await sdk.trigger("mem::consolidate-pipeline", { tier: "reflect" });

    expect(typeof seen!.triggeredAtMs).toBe("number");
    expect(seen!.triggeredAtMs).toBeGreaterThanOrEqual(before);
    expect(seen!.triggeredAtMs).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the audit row small no matter how big the run measurements get", async () => {
    // The audit row is the surface an operator reads to answer "did the last
    // run finish, and what did it skip". Audit partitions refuse enumeration
    // past 15 MiB, so fattening every row with per-tier measurements would take
    // that surface down exactly when it is needed.
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => "<facts></facts>"),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 6; i++) {
      await kv.set(KV.summaries, `ses_${i}`, makeSummary(i));
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });

    const audits = await kv.list<{ details?: unknown }>(auditQueryScopes()[0]!);
    expect(audits.length).toBe(1);
    const meta = audits[0]!.details as {
      runId?: string;
      outcomes?: Record<string, string>;
    };

    // The shape stays on the audit row, so outcomes are still answerable there.
    expect(meta.runId).toBeTruthy();
    expect(meta.outcomes!["semantic"]).toBe("ok");
    expect(meta.outcomes!["decay"]).toBe("ok");
    // The numbers do not. They live on the run row, which is a bounded ring.
    expect(JSON.stringify(audits[0]).length).toBeLessThan(600);
    expect(JSON.stringify(audits[0])).not.toContain('"ms"');

    const onRunRow = runRow(store).results!;
    expect(typeof onRunRow["semantic"]!.ms).toBe("number");
  });

  it("times a tier that threw, not just one that succeeded", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        await sleep(60);
        throw new Error("provider exploded");
      }),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 6; i++) {
      await kv.set(KV.summaries, `ses_${i}`, makeSummary(i));
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    const semantic = runRow(store).results!["semantic"]!;
    // A tier that burns the budget and then fails is the case worth timing.
    expect(semantic.status).toBe("error");
    expect(semantic.ms).toBeGreaterThanOrEqual(55);
  });
});
