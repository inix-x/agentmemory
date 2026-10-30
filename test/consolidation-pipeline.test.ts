import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  isConsolidationEnabled: vi.fn(() => true),
}));

import {
  registerConsolidationPipelineFunction,
  SEMANTIC_MAX_ROWS,
} from "../src/functions/consolidation-pipeline.js";
import { isConsolidationEnabled } from "../src/config.js";
import { logger } from "../src/logger.js";
import { currentAuditScope } from "./helpers/mocks.js";
import type {
  AuditEntry,
  SessionSummary,
  Memory,
  SemanticMemory,
  ProceduralMemory,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
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
      return entries ? (Array.from(entries.values()) as T[]) : [];
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

    const audits = await kv.list(currentAuditScope());
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
});

describe("Consolidation Pipeline semantic regrowth", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  type SemanticResult = {
    skipped?: boolean;
    reason?: string;
    error?: string;
    newFacts?: number;
    consumedSummaries?: number;
    evicted?: number;
  };
  type Run = { results: { semantic: SemanticResult } };

  const run = async () =>
    (await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" })) as Run;

  const providerWith = (summarize: ReturnType<typeof vi.fn>) => {
    const provider = { name: "test", compress: vi.fn(), summarize };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    return provider;
  };

  const seedSummaries = async (from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }
  };

  const watermark = () =>
    kv.get<{ at: string }>("mem:config", "consolidation:semanticWatermark");

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
  });

  it("does not re-send summaries a successful run already consumed", async () => {
    const provider = providerWith(
      vi
        .fn()
        .mockResolvedValueOnce(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`)
        .mockResolvedValue(`<facts><fact confidence="0.8">Vitest runs the tests</fact></facts>`),
    );
    await seedSummaries(1, 6);

    await run();
    const markAfterFirst = await watermark();
    const second = await run();

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(second.results.semantic).toMatchObject({ skipped: true });
    expect(second.results.semantic.reason).toContain("no summaries since");
    expect(await kv.list("mem:semantic")).toHaveLength(1);
    expect(await watermark()).toEqual(markAfterFirst);

    await seedSummaries(0, 0);
    const third = await run();

    expect(provider.summarize).toHaveBeenCalledTimes(2);
    expect(third.results.semantic.consumedSummaries).toBe(1);
    const prompt = vi.mocked(provider.summarize).mock.calls[1]![1] as string;
    expect(prompt).toContain("Session 0 summary");
    expect(prompt).not.toContain("Session 1 summary");
  });

  it("honors a watermark already stored under consolidation:semanticWatermark", async () => {
    const provider = providerWith(
      vi.fn().mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
    );
    await seedSummaries(0, 6);
    // Summaries 0 and 1 are newer than this; 2 to 6 were consumed before.
    const at = new Date(Date.now() - 1.5 * 86400000).toISOString();
    await kv.set("mem:config", "consolidation:semanticWatermark", { at });

    const result = await run();

    expect(result.results.semantic.consumedSummaries).toBe(2);
    const prompt = vi.mocked(provider.summarize).mock.calls[0]![1] as string;
    expect(prompt).toContain("Session 0 summary");
    expect(prompt).toContain("Session 1 summary");
    expect(prompt).not.toContain("Session 2 summary");
    const newest = await kv.get<SessionSummary>("mem:summaries", "ses_0");
    expect((await watermark())!.at).toBe(newest!.createdAt);
  });

  it.each([
    ["empty", ""],
    ["tag-free", "I could not find any durable facts in these summaries."],
    ["truncated", `<facts>\n  <fact confidence="0.9">TypeScript is the prim`],
  ])("does not advance the watermark when the merge response yields no facts (%s)", async (_, reply) => {
    providerWith(
      vi
        .fn()
        .mockResolvedValueOnce(reply)
        .mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
    );
    await seedSummaries(0, 5);

    const failed = await run();

    expect(failed.results.semantic.error).toMatch(/no facts parsed/);
    expect(await watermark()).toBeNull();

    const good = await run();
    expect(good.results.semantic).toMatchObject({ newFacts: 1, consumedSummaries: 6 });
    expect(await watermark()).not.toBeNull();
  });

  it("advances the watermark on a well-formed reply with no facts", async () => {
    const provider = providerWith(vi.fn().mockResolvedValue("<facts></facts>"));
    await seedSummaries(0, 5);

    const first = await run();
    const second = await run();

    expect(first.results.semantic).toMatchObject({ newFacts: 0, consumedSummaries: 6 });
    expect(await watermark()).not.toBeNull();
    expect(second.results.semantic).toMatchObject({ skipped: true });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("advances the watermark on a self-closing <facts/> reply", async () => {
    providerWith(vi.fn().mockResolvedValue("<facts/>"));
    await seedSummaries(0, 5);

    const result = await run();

    expect(result.results.semantic).toMatchObject({ newFacts: 0, consumedSummaries: 6 });
    expect(await watermark()).not.toBeNull();
  });

  // With no watermark yet (every existing install), the first run starts at the
  // newest 20, as upstream's window did, instead of walking the whole history.
  it("starts a store with no watermark at its newest 20 summaries", async () => {
    const provider = providerWith(
      vi.fn().mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
    );
    await seedSummaries(0, 29);

    const first = await run();
    const second = await run();

    expect(first.results.semantic.consumedSummaries).toBe(20);
    const prompt = vi.mocked(provider.summarize).mock.calls[0]![1] as string;
    expect(prompt).toContain("Session 0 summary");
    expect(prompt).toContain("Session 19 summary");
    expect(prompt).not.toContain("Session 20 summary");
    expect(second.results.semantic).toMatchObject({ skipped: true });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("drains a 45-summary backlog oldest-first over 3 runs, skipping none", async () => {
    const provider = providerWith(
      vi.fn().mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
    );
    await seedSummaries(0, 44);
    // A tie on createdAt across the first batch boundary: a time-only cursor
    // would skip whichever of the pair lands 21st.
    const ses25 = await kv.get<SessionSummary>("mem:summaries", "ses_25");
    await kv.set("mem:summaries", "ses_24", { ...makeSummary(24), createdAt: ses25!.createdAt });
    const at = new Date(Date.now() - 50 * 86400000).toISOString();
    await kv.set("mem:config", "consolidation:semanticWatermark", { at });

    const consumed: SemanticResult[] = [];
    for (let i = 0; i < 4; i++) consumed.push((await run()).results.semantic);

    expect(consumed.slice(0, 3).map((r) => r.consumedSummaries)).toEqual([20, 20, 5]);
    expect(consumed[3]).toMatchObject({ skipped: true });
    const prompts = vi.mocked(provider.summarize).mock.calls.map((c) => c[1] as string);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("Session 44 summary");
    expect(prompts[2]).toContain("Session 0 summary");
    for (let i = 0; i <= 44; i++) {
      const sent = prompts.filter((p) => p.includes(`Session ${i} summary`));
      expect(sent, `ses_${i}`).toHaveLength(1);
    }
  });

  it("keeps a truncated reply's complete facts once and warns on the missing </facts>", async () => {
    providerWith(
      vi
        .fn()
        .mockResolvedValueOnce(
          `<facts>\n  <fact confidence="0.9">TypeScript is the primary language</fact>\n  <fact confidence="0.8">Vitest ru`,
        )
        .mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
    );
    await seedSummaries(1, 6);

    const first = await run();
    await seedSummaries(0, 0);
    const second = await run();

    expect(first.results.semantic).toMatchObject({ newFacts: 1, consumedSummaries: 6 });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("</facts>"),
      expect.anything(),
    );
    expect(second.results.semantic).toMatchObject({ newFacts: 0, consumedSummaries: 1 });
    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.accessCount).toBe(2);
  });

  it("keeps the watermark monotonic when an older overlapping run finishes last", async () => {
    let releaseA!: (reply: string) => void;
    let markAEntered!: () => void;
    const aEntered = new Promise<void>((resolve) => (markAEntered = resolve));
    providerWith(
      vi
        .fn()
        .mockImplementationOnce(() => {
          markAEntered();
          return new Promise<string>((resolve) => (releaseA = resolve));
        })
        .mockResolvedValue(`<facts><fact confidence="0.8">Vitest runs the tests</fact></facts>`),
    );
    await seedSummaries(1, 6);

    // Run A has listed summaries 1 to 6 and waits on the LLM.
    const runA = run();
    await aEntered;
    await seedSummaries(0, 0);
    const b = await run();
    releaseA(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`);
    await runA;

    const newest = await kv.get<SessionSummary>("mem:summaries", "ses_0");
    expect(b.results.semantic.consumedSummaries).toBe(7);
    expect((await watermark())!.at).toBe(newest!.createdAt);
    expect((await run()).results.semantic).toMatchObject({ skipped: true });
  });

  it("holds a future-dated summary until the clock passes it, then sends it once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.parse("2026-10-30T00:00:00.000Z");
      vi.setSystemTime(start);
      const provider = providerWith(
        vi.fn().mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
      );
      await seedSummaries(1, 5);
      await kv.set("mem:summaries", "ses_future", {
        ...makeSummary(0),
        sessionId: "ses_future",
        title: "Future-dated summary",
        createdAt: new Date(start + 3_600_000).toISOString(),
      });

      const first = await run();
      const second = await run();

      expect(first.results.semantic.consumedSummaries).toBe(5);
      const firstPrompt = vi.mocked(provider.summarize).mock.calls[0]![1] as string;
      expect(firstPrompt).not.toContain("Future-dated summary");
      expect(Date.parse((await watermark())!.at)).toBeLessThanOrEqual(start);
      expect(second.results.semantic).toMatchObject({ skipped: true });

      vi.setSystemTime(start + 2 * 3_600_000);
      const third = await run();
      const fourth = await run();

      expect(third.results.semantic.consumedSummaries).toBe(1);
      const thirdPrompt = vi.mocked(provider.summarize).mock.calls[1]![1] as string;
      expect(thirdPrompt).toContain("Future-dated summary");
      expect(fourth.results.semantic).toMatchObject({ skipped: true });
      expect(provider.summarize).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-sends the same summaries when the run that read them failed", async () => {
    providerWith(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("provider down"))
        .mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
    );
    await seedSummaries(0, 5);

    const first = await run();
    const second = await run();

    expect(first.results.semantic.error).toBe("provider down");
    expect(second.results.semantic).toMatchObject({ newFacts: 1, consumedSummaries: 6 });
  });

  const GOOD_REPLY = `<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`;
  const NO_FACTS = "no facts parsed from the merge response";
  const ANTHROPIC_400_BODY = {
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long" },
  };

  // Failures caused by the batch itself: these count toward the skip.
  const contentFailures: Array<[string, () => Promise<string>, string]> = [
    ["a prose refusal", async () => "I can't help with that request.", NO_FACTS],
    [
      "a fetch-provider 400",
      async () => {
        throw new Error('OpenAI API error (400): {"error":"context_length_exceeded"}');
      },
      'OpenAI API error (400): {"error":"context_length_exceeded"}',
    ],
    [
      "a MiniMax 422",
      async () => {
        throw new Error("MiniMax API error 422: invalid params");
      },
      "MiniMax API error 422: invalid params",
    ],
    [
      "an Anthropic SDK 400",
      async () => {
        throw APIError.generate(400, ANTHROPIC_400_BODY, undefined, new Headers());
      },
      `400 ${JSON.stringify(ANTHROPIC_400_BODY)}`,
    ],
  ];

  // Failures that say nothing about the batch: these neither count nor reset.
  const transportFailures: Array<[string, () => Error]> = [
    ["a network error", () => new TypeError("fetch failed")],
    ["an SDK connection timeout", () => new APIConnectionTimeoutError()],
    [
      "a fetch-provider timeout",
      () => new Error("OpenAI API request timed out after 60000ms — set OPENAI_TIMEOUT_MS"),
    ],
    ["a 408", () => new Error("OpenRouter API error (408): request timeout")],
    ["an SDK 429", () => APIError.generate(429, {}, "rate limited", new Headers())],
    ["a 503", () => new Error("MiniMax API error 503: unavailable")],
    ["an SDK 529", () => APIError.generate(529, {}, "overloaded", new Headers())],
    ["an open circuit breaker", () => new Error("circuit_breaker_open")],
    ["a 402 (credits exhausted)", () => new Error("OpenRouter API error (402): insufficient credits")],
    ["an SDK 401", () => APIError.generate(401, {}, "invalid x-api-key", new Headers())],
    ["a 403", () => new Error("OpenAI API error (403): forbidden")],
    ["a 404 (unknown model)", () => new Error("OpenAI API error (404): model not found")],
  ];

  it.each(contentFailures)(
    "skips a batch that fails 3 runs in a row on %s and merges the next one",
    async (_label, fail, message) => {
      vi.mocked(logger.warn).mockClear();
      const provider = providerWith(
        vi.fn(async (_system: string, prompt: string) => {
          if (prompt.includes("Session 44 summary")) return fail();
          return GOOD_REPLY;
        }),
      );
      await seedSummaries(0, 44);
      const at = new Date(Date.now() - 50 * 86400000).toISOString();
      await kv.set("mem:config", "consolidation:semanticWatermark", { at });
      const firstBatch = Array.from({ length: 20 }, (_, i) => `ses_${44 - i}`);

      const failed: SemanticResult[] = [];
      for (let i = 0; i < 3; i++) failed.push((await run()).results.semantic);
      const next = await run();

      expect(failed.map((r) => r.error)).toEqual(Array(3).fill(message));
      expect(next.results.semantic).toMatchObject({ newFacts: 1, consumedSummaries: 20 });
      const prompts = vi.mocked(provider.summarize).mock.calls.map((c) => c[1] as string);
      expect(prompts).toHaveLength(4);
      expect(prompts[3]).toContain("Session 24 summary");
      expect(prompts[3]).not.toContain("Session 44 summary");
      const skips = (await kv.list<AuditEntry>(currentAuditScope())).filter(
        (a) => a.details["reason"] === "semantic batch failed 3 runs in a row",
      );
      expect(skips).toHaveLength(1);
      expect(skips[0]!.targetIds).toEqual(firstBatch);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.stringContaining("skipped"),
        expect.objectContaining({ sessionIds: firstBatch }),
      );
    },
  );

  const failures = () => kv.get("mem:config", "consolidation:semanticFailedBatch");
  const skipRows = async () =>
    (await kv.list<AuditEntry>(currentAuditScope())).filter(
      (a) => a.details["reason"] === "semantic batch failed 3 runs in a row",
    );

  it("keeps the failure count across failed runs and clears it on a success", async () => {
    providerWith(
      vi
        .fn()
        .mockResolvedValueOnce("I can't help with that request.")
        .mockResolvedValueOnce("")
        .mockResolvedValue(GOOD_REPLY),
    );
    await seedSummaries(0, 5);

    await run();
    await run();
    expect(await failures()).toMatchObject({ id: "ses_5", count: 2 });

    const good = await run();
    expect(good.results.semantic).toMatchObject({ newFacts: 1, consumedSummaries: 6 });
    expect(await failures()).toBeNull();
  });

  it.each(transportFailures)(
    "never skips a batch on %s, however many runs fail",
    async (_label, makeError) => {
      const summarize = vi.fn(async () => {
        throw makeError();
      });
      providerWith(summarize);
      await seedSummaries(0, 5);

      const failed: SemanticResult[] = [];
      for (let i = 0; i < 4; i++) failed.push((await run()).results.semantic);

      expect(failed.every((r) => typeof r.error === "string")).toBe(true);
      expect(await failures()).toBeNull();
      expect(await watermark()).toBeNull();
      expect(await skipRows()).toHaveLength(0);

      summarize.mockResolvedValue(GOOD_REPLY);
      const good = await run();
      expect(good.results.semantic).toMatchObject({ newFacts: 1, consumedSummaries: 6 });
    },
  );

  it("counts only content failures when they mix with transport failures", async () => {
    providerWith(
      vi
        .fn()
        .mockResolvedValueOnce("Sorry, no.")
        .mockRejectedValueOnce(new Error("MiniMax API error 503: unavailable"))
        .mockRejectedValueOnce(new Error("OpenAI API error (400): bad request"))
        .mockRejectedValueOnce(new Error("circuit_breaker_open"))
        .mockResolvedValueOnce("")
        .mockResolvedValue(GOOD_REPLY),
    );
    await seedSummaries(0, 5);

    for (let i = 0; i < 4; i++) await run();
    expect(await failures()).toMatchObject({ id: "ses_5", count: 2 });
    expect(await watermark()).toBeNull();
    expect(await skipRows()).toHaveLength(0);

    const third = await run();
    expect(third.results.semantic.error).toBe(NO_FACTS);
    expect(await watermark()).toMatchObject({ id: "ses_0" });
    expect(await failures()).toBeNull();
    expect(await skipRows()).toHaveLength(1);
  });

  it("writes the skip warn and audit row even when clearing the count fails", async () => {
    vi.mocked(logger.warn).mockClear();
    providerWith(vi.fn().mockResolvedValue("Sorry, no."));
    await seedSummaries(0, 5);
    const del = kv.delete;
    kv.delete = (async (scope: string, key: string) => {
      if (key === "consolidation:semanticFailedBatch") throw new Error("kv unavailable");
      return del(scope, key);
    }) as typeof kv.delete;

    for (let i = 0; i < 3; i++) await run();

    expect(await watermark()).toMatchObject({ id: "ses_0" });
    expect(await skipRows()).toHaveLength(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("skipped"),
      expect.objectContaining({ failures: 3 }),
    );
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
      "Could not record the semantic batch failure",
      expect.anything(),
    );
    kv.delete = del;
  });

  it("fails the tier, sending nothing, when the watermark read errors", async () => {
    const provider = providerWith(
      vi.fn().mockResolvedValue(`<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`),
    );
    await seedSummaries(0, 29);
    const get = kv.get;
    kv.get = (async (scope: string, key: string) => {
      if (key === "consolidation:semanticWatermark") throw new Error("kv unavailable");
      return get(scope, key);
    }) as typeof kv.get;

    const result = await run();

    expect(result.results.semantic.error).toBe("kv unavailable");
    expect(provider.summarize).not.toHaveBeenCalled();
    kv.get = get;
    expect(await watermark()).toBeNull();
  });

  it("stores a fact once when one response repeats it", async () => {
    providerWith(
      vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.8">TypeScript is the primary language</fact>` +
          `<fact confidence="0.9">typescript is the primary language</fact></facts>`,
      ),
    );
    await seedSummaries(0, 5);

    await run();

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.accessCount).toBe(2);
    expect(stored[0]!.confidence).toBe(0.9);
  });

  it("evicts the oldest one-off rows once mem:semantic is past the cap, never the new fact", async () => {
    providerWith(
      vi.fn().mockResolvedValue(`<facts><fact confidence="0.9">A brand new fact</fact></facts>`),
    );
    await seedSummaries(0, 5);
    for (let i = 0; i < SEMANTIC_MAX_ROWS - 1; i++) {
      await kv.set("mem:semantic", `sem_keep_${i}`, makeSemanticMemory({
        id: `sem_keep_${i}`,
        fact: `kept fact ${i}`,
        strength: 0.1,
      }));
    }
    const stale = ["sem_stale_a", "sem_stale_b"];
    for (const id of stale) {
      await kv.set("mem:semantic", id, makeSemanticMemory({
        id,
        fact: id,
        accessCount: 1,
        strength: 1,
        lastAccessedAt: "2026-01-01T00:00:00.000Z",
      }));
    }
    for (const id of [...stale, "sem_keep_0"]) {
      await kv.set("mem:facets", `fct_${id}`, {
        id: `fct_${id}`,
        targetId: id,
        targetType: "memory",
        dimension: "topic",
        value: "test",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await kv.set("mem:retention", id, { memoryId: id, score: 0.1 });
      await kv.set("mem:access", id, { memoryId: id, count: 1 });
    }

    const result = await run();

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored).toHaveLength(SEMANTIC_MAX_ROWS);
    expect(result.results.semantic.evicted).toBe(2);
    const ids = new Set(stored.map((s) => s.id));
    for (const id of stale) expect(ids.has(id)).toBe(false);
    expect(stored.some((s) => s.fact === "A brand new fact")).toBe(true);
    for (const id of stale) {
      expect(await kv.get("mem:facets", `fct_${id}`)).toBeNull();
      expect(await kv.get("mem:retention", id)).toBeNull();
      expect(await kv.get("mem:access", id)).toBeNull();
    }
    expect(await kv.get("mem:facets", "fct_sem_keep_0")).not.toBeNull();
    expect(await kv.get("mem:retention", "sem_keep_0")).not.toBeNull();
    expect(await kv.get("mem:access", "sem_keep_0")).not.toBeNull();

    const deletes = (await kv.list<AuditEntry>(currentAuditScope())).filter(
      (a) => a.operation === "delete",
    );
    expect(deletes).toHaveLength(1);
    expect([...deletes[0]!.targetIds].sort()).toEqual([...stale].sort());
  });

  // Reinforced facts carry the oldest lastAccessedAt in a long-lived scope, so
  // eviction by recency alone would delete exactly those first.
  it("evicts a never-reinforced row before older reinforced ones", async () => {
    providerWith(
      vi.fn().mockResolvedValue(`<facts><fact confidence="0.9">A brand new fact</fact></facts>`),
    );
    await seedSummaries(0, 5);
    const reinforced = ["sem_reinforced_a", "sem_reinforced_b"];
    for (const id of reinforced) {
      await kv.set("mem:semantic", id, makeSemanticMemory({
        id,
        fact: id,
        accessCount: 3,
        lastAccessedAt: "2026-08-13T00:00:00.000Z",
      }));
    }
    for (let i = 0; i < SEMANTIC_MAX_ROWS - 2; i++) {
      await kv.set("mem:semantic", `sem_oneoff_${i}`, makeSemanticMemory({
        id: `sem_oneoff_${i}`,
        fact: `one-off fact ${i}`,
        accessCount: 1,
        lastAccessedAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
      }));
    }

    const result = await run();

    const ids = new Set((await kv.list<SemanticMemory>("mem:semantic")).map((s) => s.id));
    expect(result.results.semantic.evicted).toBe(1);
    for (const id of reinforced) expect(ids.has(id)).toBe(true);
    expect(ids.has("sem_oneoff_0")).toBe(false);
    expect(ids.has("sem_oneoff_1")).toBe(true);

    const deletes = (await kv.list<AuditEntry>(currentAuditScope())).filter(
      (a) => a.operation === "delete",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.targetIds).toEqual(["sem_oneoff_0"]);
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
    expect(result.results.decay).toEqual({
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
