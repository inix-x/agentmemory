import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// `resolveDataDir` honours `./data/state_store.db` relative to cwd, and the
// repo's own iii-config.yaml:16 tells the engine to write exactly there. Without
// this stub, clone -> install -> run the engine once -> `npm test` turns the
// unresolved test red against unmodified source, and the maintainer sees a gate
// failure that looks like a bug in this diff. vitest.config.ts already stubs
// HOME for the same class of reason; this covers the axis that stub cannot
// reach. `resolverDataDir` lets a test point it at a seeded directory, which is
// also the only way to reach the resolver-wins branch.
let resolverDataDir = "/nonexistent-resolver-dir";
vi.mock("../src/cli-data-dir.js", () => ({
  resolveDataDir: () => ({ dataDir: resolverDataDir, source: "default" }),
}));

import {
  registerDiagnosticsStoreFunction,
  scopePrefix,
  DIAGNOSTICS_DEFAULTS,
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
  resolverDataDir = "/nonexistent-resolver-dir";
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
    // U1 is judged on the stream store alone, so a blind stream read must not
    // report success even when the state store is perfectly healthy.
    expect(result.success).toBe(false);
  });

  it("counts entries dropped from the total instead of quietly shrinking it", async () => {
    seedStateStore({ "mem:memories.bin": 10, "mem:obs:ses_a.bin": 20 });
    // A dangling symlink makes stat throw ENOENT every run, which is the same
    // shape as a file deleted between readdir and stat by the engine's own GC.
    symlinkSync(
      join(dataDir, "state_store.db", "gone"),
      join(dataDir, "state_store.db", "mem:obs:ses_dead.bin"),
    );

    const state = (await readDiagnostics()).stores.state;

    expect(state.fileCount).toBe(2);
    expect(state.totalBytes).toBe(30);
    expect(state.unreadableFiles).toBe(1);
  });

  it("reports a readable but genuinely empty store as a success", async () => {
    // The one shape that must stay a pass while its byte figures look identical
    // to the blind read above.
    seedStateStore({});

    const result = await readDiagnostics();

    expect(result.stores.state.exists).toBe(true);
    expect(result.stores.state.fileCount).toBe(0);
    expect(result.stores.state.unavailable).toBeUndefined();
    expect(result.success).toBe(true);
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
    // A stream group file is named for the raw session id. Two parts on "_", so
    // it stays whole -- this is the row that makes `> 2` load-bearing.
    ["ses_alpha.bin", "ses_alpha"],
    // Three parts on "_", so the underscore in the character class is what does
    // the splitting here.
    ["mem:obs_ses_alpha.bin", "mem:obs"],
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

  it("falls back to the resolver when the deploy default holds no store", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    resolverDataDir = dataDir;
    const bare = mkdtempSync(join(tmpdir(), "am-bare-"));

    const result = await readDiagnostics({
      dataDir: undefined,
      deployDataDir: bare,
    });

    expect(result.dataDirSource).toBe("resolver");
    expect(result.dataDir).toBe(dataDir);
    expect(result.dataDirCandidates).toEqual([bare, dataDir]);
    rmSync(bare, { recursive: true, force: true });
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

  it("pins the values production actually runs on", async () => {
    // src/index.ts registers with no overrides, so these constants are the only
    // paths production ever uses and nothing else asserts them. A typo returns
    // an unresolved dataDir and a null cgroup on Railway with every test green.
    expect(DIAGNOSTICS_DEFAULTS).toEqual({
      procRoot: "/proc",
      deployDataDir: "/data",
      cgroupPaths: [
        "/sys/fs/cgroup/memory.current",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes",
      ],
    });
  });
});

describe("process memory", () => {
  it("finds the engine by command name and converts VmRSS kB to bytes", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("101", "node", { vmRssKb: 4096 });
    seedProc("202", "iii", { vmRssKb: 2048, startTicks: 987654 });
    // Non-numeric, so the pid filter must exclude it. comm is `iii` on purpose:
    // with `node` the isEngineComm test would reject it first and the pid filter
    // would never do any work. On real Linux /proc/self mirrors this process.
    seedProc("self", "iii", { vmRssKb: 4096 });

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes).toEqual([
      { pid: 202, comm: "iii", rssBytes: 2048 * 1024, startTicks: 987654 },
    ]);
    expect(engine.rssBytes).toBe(2048 * 1024);
    expect(engine.unavailable).toBeUndefined();
  });

  it("marks a multi-process sum as overstating rather than reporting it clean", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("202", "iii", { vmRssKb: 1000 });
    seedProc("303", "iii-state", { vmRssKb: 500 });

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes).toHaveLength(2);
    expect(engine.rssBytes).toBe(1500 * 1024);
    // VmRSS counts shared pages, so the sum overstates -- and k inflating is the
    // direction that makes every unit in the ladder look better than it is. The
    // runbook tells the operator to stop and reconcile; that instruction is only
    // reachable if the payload says so through the field the checklist gates on.
    expect(engine.unavailable).toContain("overstates");
    expect(engine.unavailable).toContain("202");
    expect(engine.unavailable).toContain("303");
  });

  it("does not call a reading incomplete because an unrelated pid vanished", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("202", "iii", { vmRssKb: 1000 });
    // A numeric pid with no comm file: the process exited between readdir and
    // the read. It was never shown to be an engine process, so the engine sum is
    // complete and `unavailable` must stay absent -- otherwise the runbook sends
    // the operator to the ssh fallback and discards a valid six-hour window.
    mkdirSync(join(procRoot, "404"), { recursive: true });

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.rssBytes).toBe(1000 * 1024);
    expect(engine.unavailable).toBeUndefined();
  });

  it("names the skipped pids when the scan also failed to find an engine", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    mkdirSync(join(procRoot, "404"), { recursive: true });

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.unavailable).toContain("no iii engine");
    expect(engine.unavailable).toContain("1 pids skipped");
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
    // A zombie means the engine just died, which voids the window; EACCES means
    // the wrong uid, which is retryable. The aggregate count cannot say which,
    // so the per-process reason has to survive to the payload.
    expect(engine.processes[0]!.rssUnavailable).toContain("no VmRSS line");
  });

  it("carries the errno when the status file cannot be read at all", async () => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("202", "iii");

    const engine = (await readDiagnostics()).process.engine;

    expect(engine.processes[0]!.rssUnavailable).toBeTruthy();
    expect(engine.processes[0]!.rssUnavailable).not.toContain("no VmRSS line");
  });

  it.each([
    ["no stat file", undefined],
    ["a line with no closing paren", "202 iii 3 4 5\n"],
    ["a non-numeric field 22", `202 (iii) ${Array.from({ length: 40 }, (_, i) => (i === 19 ? "-" : String(i + 3))).join(" ")}\n`],
  ])("reports startTicks null on %s", async (_label, rawStat) => {
    seedStateStore({ "mem:memories.bin": 10 });
    seedProc("202", "iii", { vmRssKb: 10 });
    if (rawStat) writeFileSync(join(procRoot, "202", "stat"), rawStat);

    const engine = (await readDiagnostics()).process.engine;

    // Null, never 0. A 0 reads as "started at boot" and hides exactly the
    // restart the runbook uses this field to detect.
    expect(engine.processes[0]!.startTicks).toBeNull();
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
  it("registers the path, method, and auth middleware the runbook curls", () => {
    // mockSdk discards registerTrigger configs, so nothing else in this file
    // pins the route. consistency.test.ts counts `api_path:` occurrences rather
    // than their values, so a rename keeps the endpoint total at 132 too -- and
    // the operator runbook curls this exact URL.
    const api = readFileSync("src/triggers/api.ts", "utf-8");
    expect(api).toMatch(
      /api_path:\s*"\/agentmemory\/diagnostics\/store",\s*http_method:\s*"GET",\s*middleware_function_ids:\s*\["middleware::api-auth"\]/,
    );
  });

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
