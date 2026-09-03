import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerDiagnosticsStoreFunction } from "../src/functions/diagnostics-store.js";
import { registerApiTriggers } from "../src/triggers/api.js";

// U0 of the memory-reduction ladder. Every later gate in that plan is
// judged from this endpoint, so it has to be cheap and honest: it reads
// the store directories with readdir/stat and never goes through KV.
//
// The no-enumeration guarantee here is STRUCTURAL, not asserted: the
// function takes no `kv`, so it cannot list a scope. Adding enumeration
// would mean adding the parameter and threading it from src/index.ts,
// which is a visible change rather than a silent one-liner. That is a
// stronger guard than a test that watches a kv mock nobody passes.
//
// What these tests do cover is the byte accounting, which is the part
// that can go wrong quietly: a wrong sum or a wrong scope-prefix split
// makes k (resident bytes per disk byte) wrong, and k is what the whole
// ladder is ranked by.

function mockSdk() {
  const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: (
      id: string,
      fn: (payload?: unknown) => Promise<unknown>,
    ) => {
      handlers.set(id, fn);
    },
    registerTrigger: () => {},
    trigger: async (opts: { function_id: string; payload?: unknown }) => {
      const fn = handlers.get(opts.function_id);
      if (!fn) throw new Error(`no handler registered for ${opts.function_id}`);
      return fn(opts.payload);
    },
  };
  return { sdk, handlers };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async () => null,
    set: async <T>(_scope: string, _key: string, data: T): Promise<T> => data,
    delete: async (): Promise<void> => {},
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

type StoreReport = {
  path: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  byScope: Record<string, { files: number; bytes: number }>;
  largestFiles: Array<{ name: string; bytes: number }>;
};

type StoreDiagnostics = {
  success: true;
  dataDir: string;
  stores: { state: StoreReport; stream: StoreReport };
  process: {
    node: { pid: number; uptimeSeconds: number; rssBytes: number | null };
    engine: {
      rssBytes: number | null;
      processes: Array<{ pid: number; comm: string; rssBytes: number | null }>;
      unavailable?: string;
    };
    cgroupCurrentBytes: number | null;
  };
  index: { bm25Entries: number; vectorEntries: number | null };
};

let dataDir: string;
let procRoot: string;

function seedStateStore(files: Record<string, number>) {
  const dir = join(dataDir, "state_store.db");
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(dir, name), Buffer.alloc(bytes));
  }
}

// A stand-in for Linux /proc. The real one is absent on darwin and
// carries no iii process on CI, so without this the engine branch — the
// one holding VmRSS, which every gate's k divides by — is never executed
// by any test on any machine that runs the suite.
function seedProc(entry: string, comm: string, vmRssKb?: number) {
  const dir = join(procRoot, entry);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "comm"), `${comm}\n`);
  if (vmRssKb !== undefined) {
    writeFileSync(
      join(dir, "status"),
      `Name:\t${comm}\nVmPeak:\t  999999 kB\nVmRSS:\t  ${vmRssKb} kB\nThreads:\t7\n`,
    );
  }
}

async function readDiagnostics(): Promise<StoreDiagnostics> {
  const { sdk } = mockSdk();
  registerDiagnosticsStoreFunction(sdk as never, { dataDir, procRoot });
  return (await sdk.trigger({
    function_id: "mem::diagnostics-store",
  })) as StoreDiagnostics;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "am-diag-"));
  procRoot = mkdtempSync(join(tmpdir(), "am-proc-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

describe("mem::diagnostics-store reports store bytes without enumerating KV", () => {
  it("reports every file, its per-scope total, and the store total", async () => {
    seedStateStore({
      "mem:obs:ses_alpha.bin": 300,
      "mem:obs:ses_beta.bin": 200,
      "mem:memories.bin": 50,
    });

    const result = await readDiagnostics();

    expect(result.success).toBe(true);
    expect(result.dataDir).toBe(dataDir);

    const state = result.stores.state;
    expect(state.exists).toBe(true);
    expect(state.fileCount).toBe(3);
    expect(state.totalBytes).toBe(550);
    expect(state.byScope["mem:obs"]).toEqual({ files: 2, bytes: 500 });
    expect(state.byScope["mem:memories"]).toEqual({ files: 1, bytes: 50 });
    expect(state.largestFiles[0]).toEqual({
      name: "mem:obs:ses_alpha.bin",
      bytes: 300,
    });
    expect(state.largestFiles.map((f) => f.bytes)).toEqual([300, 200, 50]);
  });

  it("groups the graph and index scopes the ladder ranks by", async () => {
    seedStateStore({
      "mem:graph:nodes.bin": 400,
      "mem:graph:edges.bin": 600,
      "mem:index:bm25.bin": 1000,
      "mem:audit.bin": 25,
    });

    const state = (await readDiagnostics()).stores.state;

    expect(state.byScope["mem:graph"]).toEqual({ files: 2, bytes: 1000 });
    expect(state.byScope["mem:index"]).toEqual({ files: 1, bytes: 1000 });
    expect(state.byScope["mem:audit"]).toEqual({ files: 1, bytes: 25 });
    expect(state.totalBytes).toBe(2025);
  });

  it("caps the largest-file list at 50 without capping the totals", async () => {
    const files: Record<string, number> = {};
    for (let i = 0; i < 60; i++) files[`mem:obs:ses_${i}.bin`] = i + 1;
    seedStateStore(files);

    const state = (await readDiagnostics()).stores.state;

    expect(state.fileCount).toBe(60);
    expect(state.totalBytes).toBe((60 * 61) / 2);
    expect(state.largestFiles).toHaveLength(50);
    expect(state.largestFiles[0]!.bytes).toBe(60);
  });

  it("reports a missing stream directory as zero files, not an error", async () => {
    seedStateStore({ "mem:memories.bin": 10 });

    const result = await readDiagnostics();

    expect(result.stores.stream.exists).toBe(false);
    expect(result.stores.stream.fileCount).toBe(0);
    expect(result.stores.stream.totalBytes).toBe(0);
    expect(result.stores.stream.largestFiles).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("finds the engine by its command name and converts VmRSS kB to bytes", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("101", "node", 4096); // the worker, not the engine
    seedProc("202", "iii", 2048);
    seedProc("self", "node", 4096); // not numeric, must not be scanned

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes).toEqual([
      { pid: 202, comm: "iii", rssBytes: 2048 * 1024 },
    ]);
    expect(engine.rssBytes).toBe(2048 * 1024);
    expect(engine.unavailable).toBeUndefined();
  });

  it("sums every iii-* process so a multi-process engine is not undercounted", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("202", "iii", 1000);
    seedProc("303", "iii-state", 500);

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes).toHaveLength(2);
    expect(engine.rssBytes).toBe(1500 * 1024);
  });

  it("explains an absent engine instead of reporting a bare null", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("101", "node", 4096); // a live /proc, just no engine in it

    const result = await readDiagnostics();

    // A silent null here is indistinguishable from a real zero-RSS
    // engine, so the reason string is part of the contract: U0 divides
    // by this number and a false zero would corrupt k for the whole
    // ladder.
    expect(result.process.engine.processes).toEqual([]);
    expect(result.process.engine.rssBytes).toBeNull();
    expect(result.process.engine.unavailable).toContain("no iii engine");
  });

  it("reports node RSS and uptime from the process's own status", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("self", "node", 8192);

    const node = (await readDiagnostics()).process.node;

    expect(node.pid).toBe(process.pid);
    expect(node.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(node.rssBytes).toBe(8192 * 1024);
  });

  it("degrades to an explained null when the platform has no /proc", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    // procRoot exists but holds no `self`, which is what darwin looks
    // like: the read must not take the whole diagnostics call down.
    const result = await readDiagnostics();

    expect(result.success).toBe(true);
    expect(result.process.node.rssBytes).toBeNull();
    expect(typeof result.process.node.rssUnavailable).toBe("string");
  });

  it("reports live index entry counts", async () => {
    seedStateStore({ "mem:memories.bin": 10 });

    const result = await readDiagnostics();

    expect(typeof result.index.bm25Entries).toBe("number");
    expect(result.index.bm25Entries).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /agentmemory/diagnostics/store", () => {
  it("denies an unauthenticated request the way every other endpoint does", async () => {
    const { sdk, handlers } = mockSdk();
    registerDiagnosticsStoreFunction(sdk as never, { dataDir, procRoot });
    registerApiTriggers(sdk as never, mockKV() as never, "s3cr3t");

    const handler = handlers.get("api::diagnostics-store");
    expect(handler).toBeDefined();

    const denied = (await handler!({ headers: {} })) as {
      status_code: number;
      body: unknown;
    };
    expect(denied.status_code).toBe(401);
    expect(denied.body).toEqual({ error: "unauthorized" });
  });

  it("returns the diagnostics payload for an authorized request", async () => {
    seedStateStore({ "mem:memories.bin": 42 });
    const { sdk, handlers } = mockSdk();
    registerDiagnosticsStoreFunction(sdk as never, { dataDir, procRoot });
    registerApiTriggers(sdk as never, mockKV() as never, "s3cr3t");

    const ok = (await handlers.get("api::diagnostics-store")!({
      headers: { authorization: "Bearer s3cr3t" },
    })) as { status_code: number; body: StoreDiagnostics };

    expect(ok.status_code).toBe(200);
    expect(ok.body.stores.state.totalBytes).toBe(42);
  });
});
