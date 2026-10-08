import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  isConsolidationEnabled: vi.fn(() => true),
}));

import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { isConsolidationEnabled } from "../src/config.js";
import type { SessionSummary, Memory, SemanticMemory, ProceduralMemory } from "../src/types.js";
import { auditQueryScopes } from "../src/functions/audit.js";

// The real StateKV is an SDK round-trip, so every read returns a fresh object.
// Handing back a live reference lets a caller's later mutation retroactively
// rewrite the snapshot it was already given, which hides the stale-snapshot
// class of bug outright — and here it would make the decay assertions vacuous,
// because applyDecay mutates rows in place. Same reason as the sweep mock's
// clone (test/session-sweep.test.ts), widened to `get` and made structural so
// arrays and nested values survive the copy intact.
function detach<T>(value: T): T {
  return value && typeof value === "object" ? structuredClone(value) : value;
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
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
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
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

function makePattern(i: number): Memory {
  return {
    id: `mem_${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    type: "pattern",
    title: `Pattern ${i}`,
    content: `Always do thing ${i}`,
    concepts: ["testing"],
    files: [],
    sessionIds: ["ses_1", "ses_2"],
    strength: 5,
    version: 1,
    isLatest: true,
  };
}

function makeSemanticMemory(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  const now = new Date().toISOString();
  return {
    id: "sem_1",
    fact: "TypeScript is the primary language",
    confidence: 0.9,
    sourceSessionIds: [],
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: now,
    strength: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProceduralMemory(overrides: Partial<ProceduralMemory> = {}): ProceduralMemory {
  const now = new Date().toISOString();
  return {
    id: "proc_1",
    name: "Test Workflow",
    steps: ["step 1"],
    triggerCondition: "always",
    frequency: 1,
    sourceSessionIds: [],
    strength: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Consolidation Pipeline", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
  });

  // Harness guard. The real StateKV is an SDK round-trip that returns fresh
  // objects, so a caller cannot reach back into stored state through a value it
  // was handed. A mock that returns live references breaks that, and the whole
  // decay class of assertion goes vacuous: the decay tier mutates rows in place
  // via applyDecay, so "the write-back changed stored strength" reads as true
  // even when no kv.set ran at all. Keep this passing or those tests prove
  // nothing.
  it("hands back detached copies, so a caller's mutation cannot rewrite stored state", async () => {
    await kv.set("mem:semantic", "sem_1", { id: "sem_1", strength: 1 });

    const [listed] = await kv.list<{ id: string; strength: number }>("mem:semantic");
    listed!.strength = 0.5;
    const fetched = await kv.get<{ id: string; strength: number }>("mem:semantic", "sem_1");
    fetched!.strength = 0.25;

    const stored = await kv.get<{ id: string; strength: number }>("mem:semantic", "sem_1");
    expect(stored!.strength).toBe(1);
  });

  it("pipeline skips semantic when fewer than 5 summaries", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { skipped: boolean; reason: string };
    expect(semantic.skipped).toBe(true);
    expect(semantic.reason).toContain("fewer than 5");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("pipeline skips procedural when fewer than 2 patterns", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const mem: Memory = {
      ...makePattern(1),
      sessionIds: ["ses_1", "ses_2"],
    };
    await kv.set("mem:memories", "mem_1", mem);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { skipped: boolean; reason: string };
    expect(procedural.skipped).toBe(true);
    expect(procedural.reason).toContain("fewer than 2");
  });

  it("with enough summaries, creates semantic memories from provider response", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { newFacts: number };
    expect(semantic.newFacts).toBe(1);

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored.length).toBe(1);
    expect(stored[0].fact).toBe("TypeScript is the primary language");
    expect(stored[0].confidence).toBe(0.9);
  });

  it("with enough patterns, creates procedural memories from provider response", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Test Workflow" trigger="when writing tests"><step>Create test file</step><step>Write assertions</step></procedure></procedures>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { newProcedures: number };
    expect(procedural.newProcedures).toBe(1);

    const stored = await kv.list<ProceduralMemory>("mem:procedural");
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("Test Workflow");
    expect(stored[0].steps.length).toBe(2);
    expect(stored[0].triggerCondition).toBe("when writing tests");
  });

  it("consolidation records an audit entry", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    const audits = await kv.list(auditQueryScopes()[0]!);
    expect(audits.length).toBe(1);
  });

  it("pipeline returns early when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {})) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
    };

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("CONSOLIDATION_ENABLED");
    expect(provider.summarize).not.toHaveBeenCalled();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("pipeline proceeds with force=true even when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      force: true,
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  // Production, 2026-10-07: mem:semantic reached 104.8 MB, past the 100 MiB ws
  // frame limit, and every run after that dropped the engine socket. A scope
  // already measured over the ceiling must be skipped before it is read, and
  // the semantic tier must not fall through to inserting every fact as new.
  it("skips the semantic and decay tiers without reading a semantic scope measured over the ceiling", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }
    await kv.set("mem:semantic", "sem_1", makeSemanticMemory());
    await kv.set("mem:scope-size", "mem:semantic", {
      rows: 89_229,
      bytes: 104_802_587,
      measuredAt: "2026-10-07T06:02:34.351Z",
    });
    const listSpy = vi.spyOn(kv, "list");

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
    })) as { success: boolean; results: Record<string, { status: string; reason?: string }> };

    expect(listSpy).not.toHaveBeenCalledWith("mem:semantic");
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(result.results.semantic).toMatchObject({ status: "skipped" });
    expect(result.results.semantic.reason).toContain("mem:semantic");
    expect(result.results.decay).toMatchObject({ status: "skipped" });
    expect(await kv.list("mem:semantic")).toHaveLength(1);
  });

  // Production re-sent the same 20 newest summaries on every run, and each
  // rewording of a fact passed the exact-text dedupe as new.
  it("does not re-send summaries a successful run already consumed", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockResolvedValueOnce(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`)
        .mockResolvedValueOnce(`<facts><fact confidence="0.9">The project is written mainly in TypeScript</fact></facts>`)
        .mockResolvedValue(`<facts><fact confidence="0.8">Vitest runs the tests</fact></facts>`),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 1; i <= 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });
    const second = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { results: Record<string, { status: string; reason?: string }> };

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(second.results.semantic).toMatchObject({ status: "skipped" });
    expect(second.results.semantic.reason).toContain("no summaries since");
    expect(await kv.list("mem:semantic")).toHaveLength(1);

    await kv.set("mem:summaries", "ses_0", makeSummary(0));
    const third = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { results: Record<string, { consumedSummaries?: number }> };

    expect(provider.summarize).toHaveBeenCalledTimes(2);
    expect(third.results.semantic.consumedSummaries).toBe(1);
    const prompt = vi.mocked(provider.summarize).mock.calls[1]![1] as string;
    expect(prompt).toContain("Session 0 summary");
    expect(prompt).not.toContain("Session 1 summary");
  });

  it("re-sends the same summaries when the run that read them failed", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockRejectedValueOnce(new Error("provider down"))
        .mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const first = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { results: Record<string, { status: string }> };
    const second = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { results: Record<string, { status: string; consumedSummaries?: number }> };

    expect(first.results.semantic.status).toBe("error");
    expect(second.results.semantic).toMatchObject({ status: "ok", consumedSummaries: 6 });
  });

  it("stores a fact once when one response repeats it", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.8">TypeScript is the primary language</fact>` +
          `<fact confidence="0.9">typescript is the primary language</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.accessCount).toBe(2);
    expect(stored[0]!.confidence).toBe(0.9);
  });
});

describe("Consolidation Pipeline decay tier", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not write rows whose decay is not yet due", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await kv.set(
      "mem:semantic",
      "sem_1",
      makeSemanticMemory({ id: "sem_1", lastAccessedAt: new Date().toISOString(), strength: 1 }),
    );
    await kv.set(
      "mem:procedural",
      "proc_1",
      makeProceduralMemory({ id: "proc_1", updatedAt: new Date().toISOString(), strength: 1 }),
    );

    const setSpy = vi.spyOn(kv, "set");

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "decay",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const memoryWriteCalls = setSpy.mock.calls.filter(
      (c) => c[0] === "mem:semantic" || c[0] === "mem:procedural",
    );
    expect(memoryWriteCalls.length).toBe(0);
    expect(result.results.decay).toMatchObject({
      semantic: { scanned: 1, written: 0 },
      procedural: { scanned: 1, written: 0 },
    });

    const storedSemantic = await kv.list<SemanticMemory>("mem:semantic");
    const storedProcedural = await kv.list<ProceduralMemory>("mem:procedural");
    expect(storedSemantic[0].strength).toBe(1);
    expect(storedProcedural[0].strength).toBe(1);
  });

  it("writes only rows whose decayed strength actually changed", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const staleAccess = new Date(Date.now() - 45 * 86400000).toISOString();
    const freshAccess = new Date().toISOString();

    await kv.set(
      "mem:semantic",
      "sem_stale",
      makeSemanticMemory({ id: "sem_stale", lastAccessedAt: staleAccess, strength: 1 }),
    );
    await kv.set(
      "mem:semantic",
      "sem_fresh",
      makeSemanticMemory({ id: "sem_fresh", lastAccessedAt: freshAccess, strength: 1 }),
    );

    const setSpy = vi.spyOn(kv, "set");

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "decay",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const decay = result.results.decay as {
      semantic: { scanned: number; written: number };
      procedural: { scanned: number; written: number };
    };
    expect(decay.semantic).toEqual({ scanned: 2, written: 1 });
    expect(decay.procedural).toEqual({ scanned: 0, written: 0 });

    const semanticSetCalls = setSpy.mock.calls.filter((c) => c[0] === "mem:semantic");
    expect(semanticSetCalls.length).toBe(1);
    expect(semanticSetCalls[0][1]).toBe("sem_stale");

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    const stale = stored.find((s) => s.id === "sem_stale");
    const fresh = stored.find((s) => s.id === "sem_fresh");
    expect(stale?.strength).toBeCloseTo(0.9, 10);
    expect(fresh?.strength).toBe(1);
  });

  it("decays at most once per period, anchored to the previous decay", async () => {
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const createdAt = new Date().toISOString();
    await kv.set(
      "mem:semantic",
      "sem_1",
      makeSemanticMemory({ id: "sem_1", lastAccessedAt: createdAt, strength: 1 }),
    );

    const setSpy = vi.spyOn(kv, "set");
    const semanticWrites = () =>
      setSpy.mock.calls.filter((c) => c[0] === "mem:semantic" && c[1] === "sem_1");

    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    let stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored[0].strength).toBe(1);
    expect(stored[0].lastDecayedAt).toBeUndefined();
    expect(semanticWrites().length).toBe(0);

    const day45 = new Date(new Date(createdAt).getTime() + 45 * 86400000);
    vi.setSystemTime(day45);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored[0].strength).toBeCloseTo(0.9, 10);
    expect(stored[0].lastDecayedAt).toBe(day45.toISOString());
    expect(semanticWrites().length).toBe(1);

    const day50 = new Date(new Date(createdAt).getTime() + 50 * 86400000);
    vi.setSystemTime(day50);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored[0].strength).toBeCloseTo(0.9, 10);
    expect(stored[0].lastDecayedAt).toBe(day45.toISOString());
    expect(semanticWrites().length).toBe(1);

    const day95 = new Date(new Date(createdAt).getTime() + 95 * 86400000);
    vi.setSystemTime(day95);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored[0].strength).toBeCloseTo(0.81, 10);
    expect(stored[0].lastDecayedAt).toBe(day95.toISOString());
    expect(semanticWrites().length).toBe(2);
  });
});
