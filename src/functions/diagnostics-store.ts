import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ISdk } from "iii-sdk";
import { resolveDataDir } from "../cli-data-dir.js";
import { logger } from "../logger.js";
import { getSearchIndex, getVectorIndex } from "./search.js";

// U0 of the memory-reduction ladder. Railway reports one combined container
// figure, which cannot tell the engine's resident copy of the store apart from
// node's heap. Every later unit's gate is stated in k = engine RSS / store bytes
// on disk, so this endpoint reports both halves of that division.
//
// Every degraded read answers "why is this missing?" in one shape,
// `{ <value>, unavailable? }`. That is the contract: a believable zero is worse
// than an error here, because a wrong k mis-ranks and mis-gates every unit below
// it. CHANGELOG:689 is this repo's own precedent -- an EACCES on /data presented
// as a silent empty store while the API kept reporting success: true.

const LARGEST_FILES = 50;

// The Railway image hardcodes these in deploy/railway/entrypoint.sh via a quoted
// heredoc, so the container's stores are always at /data whatever
// AGENTMEMORY_DATA_DIR says. /data is probed first for that reason;
// resolveDataDir() covers every other install. The probe is load-bearing: inside
// the container HOME=/root survives gosu, so resolveDataDir() answers
// /root/.local/share/agentmemory, which uid node cannot read.
const STATE_STORE = "state_store.db";
const STREAM_STORE = "stream_store";

export type StoreReport = {
  path: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  byScope: Record<string, { files: number; bytes: number }>;
  largestFiles: Array<{ name: string; bytes: number }>;
  unreadableFiles?: number;
  unavailable?: string;
};

export type EngineProcess = {
  pid: number;
  comm: string;
  rssBytes: number | null;
  // Why rssBytes is null. A zombie carries no Vm* lines, which means the engine
  // just died and the six-hour window is void; EACCES means the endpoint runs as
  // the wrong uid, which is a retryable config fix. Different operator actions,
  // so the aggregate count is not enough.
  rssUnavailable?: string;
  // Raw clock ticks since boot, /proc/<pid>/stat field 22. Emitted unconverted:
  // _SC_CLK_TCK is not reachable from Node without a native addon, and assuming
  // 100 is the unit guess that turns an instrument into a confidently wrong
  // reading. Pair with bootUptimeSeconds to derive an age.
  startTicks: number | null;
};

// The values production actually runs on. src/index.ts registers with no
// overrides, so a typo in any of these returns an unresolved dataDir or a null
// cgroup on Railway while every test still passes.
export const DIAGNOSTICS_DEFAULTS = {
  procRoot: "/proc",
  deployDataDir: "/data",
  cgroupPaths: [
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ],
} as const;

export type StoreDiagnostics = {
  success: boolean;
  at: string;
  dataDir: string;
  dataDirSource: "override" | "resolver" | "deploy-default" | "unresolved";
  dataDirCandidates: string[];
  resolverUnavailable?: string;
  stores: { state: StoreReport; stream: StoreReport };
  process: {
    node: { pid: number; uptimeSeconds: number; rssBytes: number };
    engine: {
      rssBytes: number | null;
      processes: EngineProcess[];
      unavailable?: string;
    };
    cgroup: { currentBytes: number | null; unavailable?: string };
    bootUptimeSeconds: number | null;
  };
  index: { bm25Entries: number; vectorEntries: number | null };
};

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// mem:obs:ses_alpha.bin -> mem:obs, mem:graph:edges.bin -> mem:graph,
// mem:audit.bin -> mem:audit. Both ":" and "_" are separators because the
// engine's on-disk naming is not pinned by anything in this repo. A name
// splitting to exactly two parts is kept whole, so a stream group file named for
// a raw session id does not collapse -- U0 measures that naming rather than
// guessing at it, and largestFiles is always returned raw beside the grouping so
// a wrong split stays visible.
export function scopePrefix(fileName: string): string {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const parts = base.split(/[:_]/);
  return parts.length > 2 ? `${parts[0]}:${parts[1]}` : base;
}

async function readStoreDir(path: string): Promise<StoreReport> {
  const empty: StoreReport = {
    path,
    exists: false,
    fileCount: 0,
    totalBytes: 0,
    byScope: {},
    largestFiles: [],
  };

  let names: string[];
  try {
    names = await readdir(path);
  } catch (err) {
    // ENOENT is a real absence. Anything else -- EACCES, ENOTDIR -- is a store
    // we could not read, and reporting that as an empty store would satisfy
    // U1's gate ("stream file count and bytes frozen") by being blind to it.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty;
    logger.warn("diagnostics-store: store directory unreadable", {
      path,
      error: reason(err),
    });
    return { ...empty, exists: true, unavailable: reason(err) };
  }

  const sized = await Promise.all(
    names.map(async (name) => {
      try {
        const info = await stat(join(path, name));
        return { name, bytes: info.size, isFile: info.isFile() };
      } catch {
        return null;
      }
    }),
  );

  const files: Array<{ name: string; bytes: number }> = [];
  let unreadableFiles = 0;
  for (const entry of sized) {
    if (!entry) {
      unreadableFiles++;
      continue;
    }
    if (!entry.isFile) continue;
    files.push({ name: entry.name, bytes: entry.bytes });
  }

  // Null prototype: a scope prefix comes from a filename, and an inherited key
  // such as "constructor" would resolve truthy and swallow its own bucket.
  const byScope: StoreReport["byScope"] = Object.create(null);
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.bytes;
    const prefix = scopePrefix(file.name);
    const bucket = byScope[prefix] ?? { files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += file.bytes;
    byScope[prefix] = bucket;
  }

  if (unreadableFiles > 0) {
    logger.warn("diagnostics-store: entries dropped from the store total", {
      path,
      unreadableFiles,
    });
  }

  return {
    path,
    exists: true,
    fileCount: files.length,
    totalBytes,
    byScope,
    largestFiles: [...files]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, LARGEST_FILES),
    ...(unreadableFiles > 0 ? { unreadableFiles } : {}),
  };
}

function resolveStoreDataDir(
  override: string | undefined,
  deployDataDir: string,
): Pick<
  StoreDiagnostics,
  "dataDir" | "dataDirSource" | "dataDirCandidates" | "resolverUnavailable"
> {
  if (override) {
    return {
      dataDir: override,
      dataDirSource: "override",
      dataDirCandidates: [override],
    };
  }

  let resolved: string | null = null;
  let resolverUnavailable: string | undefined;
  try {
    resolved = resolveDataDir().dataDir;
  } catch (err) {
    // This is the one degraded path whose only signal used to be a log line,
    // in an endpoint that exists so gates are judgeable without shell access on
    // the container. A silently shorter candidate list reads as intended.
    resolverUnavailable = reason(err);
    logger.warn("diagnostics-store: data dir resolver threw", {
      error: resolverUnavailable,
    });
  }

  const candidates: Array<[string, StoreDiagnostics["dataDirSource"]]> = [
    [deployDataDir, "deploy-default"],
  ];
  if (resolved) candidates.push([resolved, "resolver"]);

  const paths = candidates.map(([dir]) => dir);
  const carry = resolverUnavailable ? { resolverUnavailable } : {};
  for (const [dir, source] of candidates) {
    if (existsSync(join(dir, STATE_STORE))) {
      return {
        dataDir: dir,
        dataDirSource: source,
        dataDirCandidates: paths,
        ...carry,
      };
    }
  }

  // Nothing held a store. Name the directory that was read anyway, so the
  // response shows an empty store at a stated path rather than a bare zero.
  return {
    dataDir: paths[0]!,
    dataDirSource: "unresolved",
    dataDirCandidates: paths,
    ...carry,
  };
}

// Two "no number" outcomes, and both carry a reason: a throw, and a status file
// that reads fine but has no VmRSS line (zombies and kernel threads have no Vm*
// lines by design). A bare null from either is indistinguishable from a real
// zero-RSS process.
async function readVmRss(
  procDir: string,
): Promise<{ bytes: number | null; unavailable?: string }> {
  let status: string;
  try {
    status = await readFile(join(procDir, "status"), "utf-8");
  } catch (err) {
    return { bytes: null, unavailable: reason(err) };
  }
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (!match) {
    return { bytes: null, unavailable: `no VmRSS line in ${procDir}/status` };
  }
  return { bytes: parseInt(match[1]!, 10) * 1024 };
}

// /proc/<pid>/stat field 22 is starttime. The comm field is parenthesised and
// may itself contain spaces or parens, so the tail is taken from the LAST ")" --
// splitting the whole line on " " and indexing 21 breaks on any such comm. After
// lastIndexOf(")") + 2 the first token is field 3, so field 22 is index 19.
async function readStartTicks(procDir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(procDir, "stat"), "utf-8");
    const close = raw.lastIndexOf(")");
    if (close === -1) return null;
    const ticks = Number(raw.slice(close + 2).split(" ")[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

// The engine pid file (src/cli.ts) is not usable here: the Railway entrypoint
// runs as root and execs `gosu node:node`, which preserves the environment, so
// HOME stays /root -- mode 0700, root-owned -- and writeEnginePidfile's mkdir
// EACCESes into a swallowed vlog. lsof is absent from the image too, so
// findEnginePidsByPort returns []. /proc is what the plan's own fallback
// one-liner reads, and this comm test is the exact inverse of
// isForeignPortHolder (src/cli.ts:2659), so adoptRunningEngine and this endpoint
// agree on what an engine is.
function isEngineComm(comm: string): boolean {
  const base = comm.trim().split("/").pop() ?? "";
  return base === "iii" || base.startsWith("iii-");
}

async function findEngineProcesses(procRoot: string): Promise<{
  processes: EngineProcess[];
  unavailable?: string;
}> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch (err) {
    return {
      processes: [],
      unavailable: `${procRoot} unreadable: ${reason(err)}`,
    };
  }

  const processes: EngineProcess[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const procDir = join(procRoot, entry);
    let comm: string;
    try {
      comm = await readFile(join(procDir, "comm"), "utf-8");
    } catch {
      skipped++;
      continue;
    }
    if (!isEngineComm(comm)) continue;
    const rss = await readVmRss(procDir);
    processes.push({
      pid: parseInt(entry, 10),
      comm: comm.trim(),
      rssBytes: rss.bytes,
      ...(rss.unavailable ? { rssUnavailable: rss.unavailable } : {}),
      startTicks: await readStartTicks(procDir),
    });
  }

  const skippedNote =
    skipped > 0 ? ` (${skipped} pids skipped: comm unreadable)` : "";
  if (processes.length === 0) {
    return {
      processes,
      unavailable: `no iii engine process found under ${procRoot}${skippedNote}`,
    };
  }
  // A matched process whose VmRSS could not be read contributes nothing to the
  // sum, so without this the response reports a strict subset of the engine as
  // if it were all of it -- a silent undercount of k's numerator.
  const missing = processes.filter((p) => p.rssBytes === null);
  if (missing.length > 0) {
    const shape = missing.length === processes.length ? "null" : "a partial sum";
    return {
      processes,
      unavailable: `VmRSS unreadable for ${missing.length}/${processes.length} matched processes (pids ${missing
        .map((p) => p.pid)
        .join(", ")}); engine.rssBytes is ${shape}${skippedNote}`,
    };
  }
  // VmRSS counts shared pages, so adding it across processes overstates
  // resident bytes -- and k inflating is the direction that makes every unit in
  // the ladder look more attractive than it is. `iii-*` is exactly the worker
  // naming the entrypoint uses, so this is one engine build away from live.
  if (processes.length > 1) {
    return {
      processes,
      unavailable: `engine.rssBytes sums ${processes.length} processes (pids ${processes
        .map((p) => p.pid)
        .join(", ")}); VmRSS counts shared pages, so the sum overstates resident bytes${skippedNote}`,
    };
  }
  // A pid whose comm could not be read was never shown to be an engine process,
  // so on its own it does not make this reading incomplete. Reporting it through
  // `unavailable` would tell the operator k cannot be computed when it can.
  return { processes };
}

async function readCgroupCurrent(
  paths: readonly string[],
): Promise<{ currentBytes: number | null; unavailable?: string }> {
  const failures: string[] = [];
  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf-8");
      const bytes = parseInt(raw.trim(), 10);
      if (Number.isFinite(bytes)) return { currentBytes: bytes };
      failures.push(`${path}: not a number`);
    } catch (err) {
      failures.push(`${path}: ${reason(err)}`);
    }
  }
  return { currentBytes: null, unavailable: failures.join("; ") };
}

async function readBootUptime(procRoot: string): Promise<number | null> {
  try {
    const raw = await readFile(join(procRoot, "uptime"), "utf-8");
    const seconds = Number(raw.trim().split(" ")[0]);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

// The overrides make the filesystem reads drivable from a temp directory.
// Without them the engine and cgroup halves run on no machine the suite executes
// on, and those halves carry VmRSS and the container figure -- two of the three
// numbers this endpoint exists to report.
export function registerDiagnosticsStoreFunction(
  sdk: ISdk,
  overrides: {
    dataDir?: string;
    deployDataDir?: string;
    procRoot?: string;
    cgroupPaths?: readonly string[];
  } = {},
): void {
  const procRoot = overrides.procRoot ?? DIAGNOSTICS_DEFAULTS.procRoot;
  const cgroupPaths = overrides.cgroupPaths ?? DIAGNOSTICS_DEFAULTS.cgroupPaths;
  const deployDataDir = overrides.deployDataDir ?? DIAGNOSTICS_DEFAULTS.deployDataDir;
  sdk.registerFunction(
    "mem::diagnostics-store",
    async (): Promise<StoreDiagnostics> => {
      const at = new Date().toISOString();
      const {
        dataDir,
        dataDirSource,
        dataDirCandidates,
        resolverUnavailable,
      } = resolveStoreDataDir(
        overrides.dataDir,
        deployDataDir,
      );

      const [state, stream, engine, cgroup, bootUptimeSeconds] =
        await Promise.all([
          readStoreDir(join(dataDir, STATE_STORE)),
          readStoreDir(join(dataDir, STREAM_STORE)),
          findEngineProcesses(procRoot),
          readCgroupCurrent(cgroupPaths),
          readBootUptime(procRoot),
        ]);

      const engineRss = engine.processes.reduce<number | null>(
        (sum, proc) =>
          proc.rssBytes === null ? sum : (sum ?? 0) + proc.rssBytes,
        null,
      );

      return {
        // Not a literal: 20+ sibling modules return success: false on failure,
        // so callers branch on it. A hardcoded true would pass cleanly on a
        // response whose every byte figure is a false zero (CHANGELOG:689).
        //
        // An unreadable STREAM store counts too. U1's gate metric is "stream
        // file count and total bytes from the U0 endpoint", threshold "frozen
        // across the window" -- so a blind stream read passes U1 by seeing
        // nothing. An ABSENT stream store is not a failure: the plan's own U0
        // scenario requires "a missing stream directory reports zero files and
        // no error", which is why this tests `unavailable` and not `exists`.
        success: state.exists && !state.unavailable && !stream.unavailable,
        at,
        dataDir,
        dataDirSource,
        dataDirCandidates,
        ...(resolverUnavailable ? { resolverUnavailable } : {}),
        stores: { state, stream },
        process: {
          node: {
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime()),
            rssBytes: process.memoryUsage().rss,
          },
          engine: {
            rssBytes: engineRss,
            processes: engine.processes,
            ...(engine.unavailable ? { unavailable: engine.unavailable } : {}),
          },
          cgroup,
          bootUptimeSeconds,
        },
        index: {
          bm25Entries: getSearchIndex().size,
          vectorEntries: getVectorIndex()?.size ?? null,
        },
      };
    },
  );
}
