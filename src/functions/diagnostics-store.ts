import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IIIClient } from "iii-sdk";
import { resolveDataDir } from "../cli-data-dir.js";
import { logger } from "../logger.js";
import { getSearchIndex, getVectorIndex } from "./search.js";

// Fork-only memory instrument. Railway reports one combined container figure,
// which cannot tell the store's resident copy apart from node's heap. This
// endpoint reports the on-disk store bytes and the RSS of every compose process
// separately, so a memory gate is judgeable without shell access.
//
// Every degraded read answers "why is this missing?" in one shape,
// `{ <value>, unavailable? }`. A believable zero is worse than an error here:
// CHANGELOG:689 is this repo's own precedent -- an EACCES on /data presented as
// a silent empty store while the API kept reporting success: true.

const LARGEST_FILES = 50;

// deploy/runtime/worker-compose.yaml points the state worker at
// /data/state_store.db. /data is probed first; resolveDataDir() covers every
// other install.
const STATE_STORE = "state_store.db";

export type StoreReport = {
  path: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  byScope: Record<string, { files: number; bytes: number }>;
  largestFiles: Array<{ name: string; bytes: number }>;
  unreadableFiles?: number;
  // A subdirectory holds bytes this reader does not walk. Counted rather than
  // dropped, because otherwise a nested layout is indistinguishable from a
  // genuinely empty store.
  directoriesSkipped?: number;
  unavailable?: string;
};

// `iii compose` runs the engine and each worker as its own process. The
// package workers are the `state` and `http` binaries
// (test/compose-supervision-integration.test.ts launches them under those
// names); the `iii-` forms are accepted too until a live /proc confirms which
// one the package install produces. Any other `iii-*` process lands in
// `other` rather than vanishing from the report.
export const PROCESS_ROLES = [
  "engine",
  "state",
  "http",
  "agentmemory",
  "other",
] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

export type ComposeProcess = {
  pid: number;
  comm: string;
  role: ProcessRole;
  rssBytes: number | null;
  // Why rssBytes is null. A zombie carries no Vm* lines, which means the
  // process just died; EACCES means the endpoint runs as the wrong uid. Different
  // operator actions, so the per-role summary is not enough.
  rssUnavailable?: string;
  // Raw clock ticks since boot, /proc/<pid>/stat field 22. Emitted unconverted:
  // _SC_CLK_TCK is not reachable from Node without a native addon. Pair with
  // process.boot.uptimeSeconds to derive an age.
  startTicks: number | null;
};

export type RoleRss = { rssBytes: number | null; unavailable?: string };

// The values production runs on. src/index.ts registers with no overrides, so a
// typo in any of these returns an unresolved dataDir or a null cgroup on
// Railway while every test still passes.
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
  stores: { state: StoreReport };
  process: {
    node: { pid: number; uptimeSeconds: number; rssBytes: number };
    compose: {
      processes: ComposeProcess[];
      roles: Record<Exclude<ProcessRole, "other">, RoleRss>;
      unavailable?: string;
    };
    cgroup: { currentBytes: number | null; unavailable?: string };
    boot: { uptimeSeconds: number | null; unavailable?: string };
  };
  index: { bm25Entries: number; vectorEntries: number | null };
};

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// mem:obs:ses_alpha.bin -> mem:obs, mem:graph:edges.bin -> mem:graph,
// mem:audit.bin -> mem:audit. Both ":" and "_" are separators because the
// engine's on-disk naming is not pinned by anything in this repo. A name
// splitting to exactly two parts is kept whole. largestFiles is always returned
// raw beside the grouping so a wrong split stays visible.
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
    byScope: Object.create(null),
    largestFiles: [],
  };

  let names: string[];
  try {
    names = await readdir(path);
  } catch (err) {
    // ENOENT is a real absence. Anything else -- EACCES, ENOTDIR -- is a store
    // we could not read, and reporting that as an empty store is blind to it.
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
  let directoriesSkipped = 0;
  for (const entry of sized) {
    if (!entry) {
      unreadableFiles++;
      continue;
    }
    if (!entry.isFile) {
      directoriesSkipped++;
      continue;
    }
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

  if (unreadableFiles > 0 || directoriesSkipped > 0) {
    logger.warn("diagnostics-store: entries dropped from the store total", {
      path,
      unreadableFiles,
      directoriesSkipped,
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
    ...(directoriesSkipped > 0 ? { directoriesSkipped } : {}),
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
    // A silently shorter candidate list reads as intended, so the throw is
    // surfaced in the response and not only in a log line.
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
// may itself contain spaces or parens, so the tail is taken from the LAST ")".
// After lastIndexOf(")") + 2 the first token is field 3, so field 22 is index 19.
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

// The agentmemory worker is matched by pid, not by comm: comm is `node`, and
// the Docker HEALTHCHECK spawns a transient `node -e` every 30 s.
export function classifyProcess(
  comm: string,
  pid: number,
  selfPid: number,
): ProcessRole | null {
  if (pid === selfPid) return "agentmemory";
  const base = comm.trim().split("/").pop() ?? "";
  if (base === "iii") return "engine";
  const name = base.startsWith("iii-") ? base.slice(4) : base;
  if (name === "state" || name === "http") return name;
  return base.startsWith("iii-") ? "other" : null;
}

function summarizeRole(role: ProcessRole, matched: ComposeProcess[]): RoleRss {
  if (matched.length === 0) {
    return { rssBytes: null, unavailable: `no ${role} process found` };
  }
  const rssBytes = matched.reduce<number | null>(
    (sum, proc) => (proc.rssBytes === null ? sum : (sum ?? 0) + proc.rssBytes),
    null,
  );
  // A matched process whose VmRSS could not be read contributes nothing, so
  // without this the role reports a strict subset of itself as all of it.
  const missing = matched.filter((p) => p.rssBytes === null);
  if (missing.length > 0) {
    const shape = missing.length === matched.length ? "null" : "a partial sum";
    return {
      rssBytes,
      unavailable: `VmRSS unreadable for ${missing.length}/${matched.length} ${role} processes (pids ${missing
        .map((p) => p.pid)
        .join(", ")}); rssBytes is ${shape}`,
    };
  }
  // VmRSS counts shared pages, so adding it across processes of one role
  // overstates resident bytes.
  if (matched.length > 1) {
    return {
      rssBytes,
      unavailable: `rssBytes sums ${matched.length} ${role} processes (pids ${matched
        .map((p) => p.pid)
        .join(", ")}); VmRSS counts shared pages, so the sum overstates resident bytes`,
    };
  }
  return { rssBytes };
}

async function findComposeProcesses(
  procRoot: string,
): Promise<StoreDiagnostics["process"]["compose"]> {
  const roles = (processes: ComposeProcess[]) =>
    Object.fromEntries(
      PROCESS_ROLES.filter((role) => role !== "other").map((role) => [
        role,
        summarizeRole(
          role,
          processes.filter((p) => p.role === role),
        ),
      ]),
    ) as StoreDiagnostics["process"]["compose"]["roles"];

  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch (err) {
    return {
      processes: [],
      roles: roles([]),
      unavailable: `${procRoot} unreadable: ${reason(err)}`,
    };
  }

  const processes: ComposeProcess[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    const procDir = join(procRoot, entry);
    let comm: string;
    try {
      comm = await readFile(join(procDir, "comm"), "utf-8");
    } catch {
      skipped++;
      continue;
    }
    const role = classifyProcess(comm, pid, process.pid);
    if (!role) continue;
    const rss = await readVmRss(procDir);
    processes.push({
      pid,
      comm: comm.trim(),
      role,
      rssBytes: rss.bytes,
      ...(rss.unavailable ? { rssUnavailable: rss.unavailable } : {}),
      startTicks: await readStartTicks(procDir),
    });
  }

  // A pid whose comm could not be read was never shown to be a compose
  // process, so it only matters when the scan found nothing at all.
  return {
    processes,
    roles: roles(processes),
    ...(processes.length === 0
      ? {
          unavailable: `no compose process found under ${procRoot}${
            skipped > 0 ? ` (${skipped} pids skipped: comm unreadable)` : ""
          }`,
        }
      : {}),
  };
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

// Same `{ value, unavailable? }` shape as cgroup. Paired with startTicks to
// decide whether a process restarted inside a window, and a reason-free null
// there reads as "it did not".
async function readBootUptime(
  procRoot: string,
): Promise<{ seconds: number | null; unavailable?: string }> {
  const path = join(procRoot, "uptime");
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    return { seconds: null, unavailable: `${path}: ${reason(err)}` };
  }
  const seconds = Number(raw.trim().split(" ")[0]);
  if (!Number.isFinite(seconds)) {
    return { seconds: null, unavailable: `${path}: not a number` };
  }
  return { seconds };
}

// The overrides make the filesystem reads drivable from a temp directory.
// Without them the process and cgroup halves run on no machine the suite
// executes on.
export function registerDiagnosticsStoreFunction(
  sdk: IIIClient,
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
      } = resolveStoreDataDir(overrides.dataDir, deployDataDir);

      const [state, compose, cgroup, boot] = await Promise.all([
        readStoreDir(join(dataDir, STATE_STORE)),
        findComposeProcesses(procRoot),
        readCgroupCurrent(cgroupPaths),
        readBootUptime(procRoot),
      ]);

      return {
        // Not a literal: sibling modules return success: false on failure, so
        // callers branch on it. A hardcoded true would pass cleanly on a
        // response whose every byte figure is a false zero (CHANGELOG:689).
        success: state.exists && !state.unavailable,
        at,
        dataDir,
        dataDirSource,
        dataDirCandidates,
        ...(resolverUnavailable ? { resolverUnavailable } : {}),
        stores: { state },
        process: {
          node: {
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime()),
            rssBytes: process.memoryUsage().rss,
          },
          compose,
          cgroup,
          boot: {
            uptimeSeconds: boot.seconds,
            ...(boot.unavailable ? { unavailable: boot.unavailable } : {}),
          },
        },
        index: {
          bm25Entries: getSearchIndex().size,
          vectorEntries: getVectorIndex()?.size ?? null,
        },
      };
    },
  );
}
