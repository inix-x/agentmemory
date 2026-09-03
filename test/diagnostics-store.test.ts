import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerDiagnosticsStoreFunction,
  scopePrefix,
  type StoreDiagnostics,
} from "../src/functions/diagnostics-store.js";
import { registerApiTriggers } from "../src/triggers/api.js";

// U0 of the memory-reduction ladder. Every later gate is judged from this
// endpoint, so its failure mode is not a crash, it is a confidently wrong
// number. These tests exist mostly to pin the difference between "this value is
// missing and here is why" and a bare zero that reads like a measurement.
//
// The no-enumeration property is asserted, not argued. It is structural for
// `mem::diagnostics-store`, which takes no kv -- but `registerApiTriggers`
// closes over kv and registers the HTTP handler inside that body, so the
// endpoint CAN reach kv with a one-line edit and no signature change. The
// listCalls recorder below is the only thing standing in the way.

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

// Mirrors test/observe-cap-without-enumeration.test.ts:19,45 -- the listCalls
// recorder is the point of this mock, not incidental to it.
function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listCalls: string[] = [];
  return {
    listCalls,
    get: async () => null,
    set: async <T>(_scope: string, _key: string, data: T): Promise<T> => data,
    delete: async (): Promise<void> => {},
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

let dataDir: string;
let procRoot: string;
let cgroupDir: string;

function seedStore(store: string, files: Record<string, number>) {
  const dir = join(dataDir, store);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(dir, name), Buffer.alloc(bytes));
  }
}

const seedStateStore = (files: Record<string, number>) =>
  seedStore("state_store.db", files);

// A stand-in for Linux /proc. The real one is absent on darwin and carries no
// iii process on CI, so without this the engine branch -- which holds VmRSS, the
// numerator of k -- is never executed by any test on any machine.
function seedProc(
  entry: string,
  comm: string,
  opts: { vmRssKb?: number; startTicks?: number; statComm?: string } = {},
) {
  const dir = join(procRoot, entry);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "comm"), `${comm}\n`);
  if (opts.vmRssKb !== undefined) {
    writeFileSync(
      join(dir, "status"),
      `Name:\t${comm}\nVmPeak:\t  999999 kB\nVmRSS:\t  ${opts.vmRssKb} kB\nThreads:\t7\n`,
    );
  }
  if (opts.startTicks !== undefined) {
    // Real layout: `pid (comm) state ppid ...`. tokens[0] is field 3 (state),
    // so starttime, field 22, is tokens[19]. Each token is filled with its own
    // field number so a wrong index shows up as a recognisable value.
    const tokens = Array.from({ length: 40 }, (_, i) => String(i + 3));
    tokens[19] = String(opts.startTicks);
    writeFileSync(
      join(dir, "stat"),
      `${entry} (${opts.statComm ?? comm}) ${tokens.join(" ")}\n`,
    );
  }
}

function seedCgroup(name: string, body: string): string {
  const path = join(cgroupDir, name);
  writeFileSync(path, body);
  return path;
}

async function readDiagnostics(
  extra: Record<string, unknown> = {},
): Promise<StoreDiagnostics> {
  const { sdk } = mockSdk();
  registerDiagnosticsStoreFunction(sdk as never, {
    dataDir,
    procRoot,
    cgroupPaths: [join(cgroupDir, "missing")],
    ...extra,
  });
  return (await sdk.trigger({
    function_id: "mem::diagnostics-store",
  })) as StoreDiagnostics;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "am-diag-"));
  procRoot = mkdtempSync(join(tmpdir(), "am-proc-"));
  cgroupDir = mkdtempSync(join(tmpdir(), "am-cg-"));
});

afterEach(() => {
  for (const dir of [dataDir, procRoot, cgroupDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("store byte accounting", () => {
  it("reports every file, its per-scope total, and the store total", async () => {
    seedStateStore({
      "mem:obs:ses_alpha.bin": 300,
      "mem:obs:ses_beta.bin": 200,
      "mem:memories.bin": 50,
      "mem:graph:nodes.bin": 400,
      "mem:index:bm25.bin": 1000,
    });
    // A non-file entry must not inflate the count or the total.
    mkdirSync(join(dataDir, "state_store.db", "nested"));

    const result = await readDiagnostics();
    const state = result.stores.state;

    expect(result.success).toBe(true);
    expect(state.exists).toBe(true);
    expect(state.fileCount).toBe(5);
    expect(state.totalBytes).toBe(1950);
    expect(state.byScope["mem:obs"]).toEqual({ files: 2, bytes: 500 });
    expect(state.byScope["mem:memories"]).toEqual({ files: 1, bytes: 50 });
    expect(state.byScope["mem:graph"]).toEqual({ files: 1, bytes: 400 });
    expect(state.byScope["mem:index"]).toEqual({ files: 1, bytes: 1000 });
    expect(state.byScope["nested"]).toBeUndefined();
    expect(state.largestFiles[0]).toEqual({
      name: "mem:index:bm25.bin",
      bytes: 1000,
    });
    expect(state.largestFiles.map((f) => f.name)).not.toContain("nested");
    expect(state.unavailable).toBeUndefined();
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

  it("reports a missing store as absent, with no reason", async () => {
    seedStateStore({ "mem:memories.bin": 10 });

    const stream = (await readDiagnostics()).stores.stream;

    expect(stream.exists).toBe(false);
    expect(stream.fileCount).toBe(0);
    expect(stream.totalBytes).toBe(0);
    expect(stream.unavailable).toBeUndefined();
  });

  it("distinguishes an unreadable store from an absent one", async () => {
    // A store path that is a plain file: readdir gives ENOTDIR, not ENOENT. An
    // unreadable store reported as an empty one would satisfy U1's gate
    // ("stream file count and bytes frozen") by being blind to it.
    seedStateStore({ "mem:memories.bin": 10 });
    writeFileSync(join(dataDir, "stream_store"), "not a directory");

    const result = await readDiagnostics();
    const stream = result.stores.stream;

    expect(stream.exists).toBe(true);
    expect(stream.fileCount).toBe(0);
    expect(typeof stream.unavailable).toBe("string");
    expect(stream.unavailable!.length).toBeGreaterThan(0);
  });

  it("reports success false when the state store itself is unreadable", async () => {
    writeFileSync(join(dataDir, "state_store.db"), "not a directory");

    const result = await readDiagnostics();

    expect(result.success).toBe(false);
    expect(result.stores.state.unavailable).toBeTruthy();
  });

  it("keeps a scope named after an Object prototype key in its own bucket", async () => {
    seedStateStore({ "constructor.bin": 7, "mem:memories.bin": 3 });

    const state = (await readDiagnostics()).stores.state;

    expect(state.byScope["constructor"]).toEqual({ files: 1, bytes: 7 });
    expect(state.totalBytes).toBe(10);
  });
});

describe("scopePrefix", () => {
  it.each([
    ["mem:obs:ses_alpha.bin", "mem:obs"],
    ["mem:index:bm25:bm25:idx_x_y:00000.bin", "mem:index"],
    ["mem:graph:node-degree.bin", "mem:graph"],
    ["mem:team:team_a:users:u_1.bin", "mem:team"],
    ["mem:memories.bin", "mem:memories"],
    ["mem:recent-searches.bin", "mem:recent-searches"],
    ["mem:audit", "mem:audit"],
  ])("maps %s to %s", (name, expected) => {
    expect(scopePrefix(name)).toBe(expected);
  });
});

describe("data directory resolution", () => {
  it("prefers the deploy default when it holds a store", async () => {
    seedStateStore({ "mem:memories.bin": 10 });

    const result = await readDiagnostics({
      dataDir: undefined,
      deployDataDir: dataDir,
    });

    expect(result.dataDirSource).toBe("deploy-default");
    expect(result.dataDir).toBe(dataDir);
    expect(result.dataDirCandidates[0]).toBe(dataDir);
  });

  it("says unresolved when no candidate holds a store", async () => {
    const bare = mkdtempSync(join(tmpdir(), "am-bare-"));

    const result = await readDiagnostics({
      dataDir: undefined,
      deployDataDir: bare,
    });

    // The operator runbook's first instrument check keys on this: unresolved
    // means every byte figure below it is a false zero.
    expect(result.dataDirSource).toBe("unresolved");
    expect(result.dataDirCandidates).toContain(bare);
    expect(result.success).toBe(false);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("process memory", () => {
  it("finds the engine by command name and converts VmRSS kB to bytes", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("101", "node", { vmRssKb: 4096 });
    seedProc("202", "iii", { vmRssKb: 2048, startTicks: 987654 });
    seedProc("self", "node", { vmRssKb: 4096 });

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes).toEqual([
      { pid: 202, comm: "iii", rssBytes: 2048 * 1024, startTicks: 987654 },
    ]);
    expect(engine.rssBytes).toBe(2048 * 1024);
    expect(engine.unavailable).toBeUndefined();
  });

  it("sums every iii-* process so a multi-process engine is not undercounted", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("202", "iii", { vmRssKb: 1000 });
    seedProc("303", "iii-state", { vmRssKb: 500 });

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes).toHaveLength(2);
    expect(engine.rssBytes).toBe(1500 * 1024);
  });

  it("flags a partial sum when one matched process has no readable VmRSS", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("202", "iii", { vmRssKb: 1000 });
    seedProc("303", "iii-state");

    const engine = (await readDiagnostics()).process.engine;

    // Without this the response reports a strict subset of the engine as if it
    // were all of it, and the runbook's checklist (processes non-empty,
    // unavailable unset) green-lights it.
    expect(engine.rssBytes).toBe(1000 * 1024);
    expect(engine.unavailable).toContain("partial sum");
    expect(engine.unavailable).toContain("303");
  });

  it("explains a status file that reads but carries no VmRSS line", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    const dir = join(procRoot, "202");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "comm"), "iii\n");
    // Zombies and kernel threads have no Vm* lines by design, so this returns
    // null without throwing.
    writeFileSync(join(dir, "status"), "Name:\tiii\nState:\tZ (zombie)\n");

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.rssBytes).toBeNull();
    expect(engine.processes[0]!.rssBytes).toBeNull();
    expect(engine.unavailable).toContain("VmRSS unreadable");
  });

  it("explains an absent engine instead of reporting a bare null", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("101", "node", { vmRssKb: 4096 });

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes).toEqual([]);
    expect(engine.rssBytes).toBeNull();
    expect(engine.unavailable).toContain("no iii engine");
  });

  it("parses starttime from the last paren so a comm with parens cannot shift it", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("202", "iii", {
      vmRssKb: 10,
      startTicks: 555444,
      statComm: "iii (worker) x",
    });

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes[0]!.startTicks).toBe(555444);
  });

  it("reads node RSS from the stdlib, so it never degrades off Linux", async () => {
    seedStateStore({ "mem:memories.bin": 10 });

    const node = (await readDiagnostics()).process.node;

    expect(node.pid).toBe(process.pid);
    expect(node.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(node.rssBytes).toBeGreaterThan(0);
  });

  it("reports boot uptime so an engine restart inside a window is detectable", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    writeFileSync(join(procRoot, "uptime"), "12345.67 98765.43\n");

    const result = await readDiagnostics();

    expect(result.process.bootUptimeSeconds).toBeCloseTo(12345.67);
  });

  it("reports null boot uptime when the platform has no /proc/uptime", async () => {
    seedStateStore({ "mem:memories.bin": 10 });

    expect((await readDiagnostics()).process.bootUptimeSeconds).toBeNull();
  });
});

describe("cgroup current", () => {
  it("reads the first path that holds a number", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    const path = seedCgroup("memory.current", "4194304\n");

    const cgroup = (await readDiagnostics({ cgroupPaths: [path] })).process
      .cgroup;

    expect(cgroup.currentBytes).toBe(4194304);
    expect(cgroup.unavailable).toBeUndefined();
  });

  it("falls through to the v1 path when v2 is not a number", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    const v2 = seedCgroup("memory.current", "max\n");
    const v1 = seedCgroup("memory.usage_in_bytes", "8388608\n");

    const cgroup = (await readDiagnostics({ cgroupPaths: [v2, v1] })).process
      .cgroup;

    expect(cgroup.currentBytes).toBe(8388608);
  });

  it("names both paths when neither is readable", async () => {
    seedStateStore({ "mem:memories.bin": 10 });

    const cgroup = (
      await readDiagnostics({
        cgroupPaths: [join(cgroupDir, "a"), join(cgroupDir, "b")],
      })
    ).process.cgroup;

    expect(cgroup.currentBytes).toBeNull();
    expect(cgroup.unavailable).toContain("a");
    expect(cgroup.unavailable).toContain("b");
  });
});

describe("index counts", () => {
  it("reports the live index sizes", async () => {
    seedStateStore({ "mem:memories.bin": 10 });

    const index = (await readDiagnostics()).index;

    // Nothing in this file seeds the index and the module registry is fresh per
    // test file, so these exact values are the real contract.
    expect(index.bm25Entries).toBe(0);
    expect(index.vectorEntries).toBeNull();
  });
});

describe("GET /agentmemory/diagnostics/store", () => {
  it("denies an unauthenticated request the way every other endpoint does", async () => {
    const { sdk, handlers } = mockSdk();
    registerDiagnosticsStoreFunction(sdk as never, { dataDir, procRoot });
    registerApiTriggers(sdk as never, mockKV() as never, "s3cr3t");

    const denied = (await handlers.get("api::diagnostics-store")!({
      headers: {},
    })) as { status_code: number; body: unknown };

    expect(denied.status_code).toBe(401);
    expect(denied.body).toEqual({ error: "unauthorized" });
  });

  it("answers an authorized request without enumerating any KV scope", async () => {
    seedStateStore({ "mem:memories.bin": 42 });
    const { sdk, handlers } = mockSdk();
    const kv = mockKV();
    registerDiagnosticsStoreFunction(sdk as never, { dataDir, procRoot });
    registerApiTriggers(sdk as never, kv as never, "s3cr3t");

    const ok = (await handlers.get("api::diagnostics-store")!({
      headers: { authorization: "Bearer s3cr3t" },
    })) as { status_code: number; body: StoreDiagnostics };

    expect(ok.status_code).toBe(200);
    expect(ok.body.stores.state.totalBytes).toBe(42);
    // registerApiTriggers closes over kv, so the handler can reach it with a
    // one-line edit and no signature change. This is the guard.
    expect(kv.listCalls).toEqual([]);
  });
});
