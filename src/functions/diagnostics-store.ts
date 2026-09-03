import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ISdk } from "iii-sdk";
import { resolveDataDir } from "../cli-data-dir.js";
import { getSearchIndex, getVectorIndex } from "./search.js";

// U0 of the memory-reduction ladder. Railway reports one combined
// container figure, so without this endpoint every unit in that ladder
// is an owner-only gate that needs shell access. It answers the three
// questions each later gate is judged on: what the store holds per
// scope, how that maps to resident bytes in the engine versus node, and
// what the container as a whole is charged for.
//
// It takes no `kv` on purpose. The whole point is a cheap read, and a
// function that cannot reach KV cannot grow a kv.list on the quiet.
// Everything here is readdir/stat/readFile against paths.

const LARGEST_FILES = 50;

// The Railway image hardcodes these in deploy/railway/entrypoint.sh via a
// quoted heredoc, so the container's stores are at /data regardless of
// AGENTMEMORY_DATA_DIR. resolveDataDir() covers every other install.
const DEPLOY_DATA_DIR = "/data";
const STATE_STORE = "state_store.db";
const STREAM_STORE = "stream_store";

export type StoreReport = {
  path: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  byScope: Record<string, { files: number; bytes: number }>;
  largestFiles: Array<{ name: string; bytes: number }>;
};

export type EngineProcess = {
  pid: number;
  comm: string;
  rssBytes: number | null;
};

export type StoreDiagnostics = {
  success: true;
  at: string;
  dataDir: string;
  dataDirSource: "override" | "resolver" | "deploy-default" | "unresolved";
  dataDirCandidates: string[];
  stores: { state: StoreReport; stream: StoreReport };
  process: {
    node: {
      pid: number;
      uptimeSeconds: number;
      rssBytes: number | null;
      rssUnavailable?: string;
    };
    engine: {
      rssBytes: number | null;
      processes: EngineProcess[];
      unavailable?: string;
    };
    cgroupCurrentBytes: number | null;
    cgroupUnavailable?: string;
  };
  index: { bm25Entries: number; vectorEntries: number | null };
};

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// mem:obs:ses_alpha.bin -> mem:obs, mem:graph:edges.bin -> mem:graph,
// mem:audit.bin -> mem:audit. The engine's on-disk naming is not pinned
// by anything in this repo, so both ":" and "_" are treated as scope
// separators and the raw largestFiles list is always returned beside the
// grouping — a wrong split stays visible instead of silently rebucketing
// the numbers the ladder is ranked by.
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
  } catch {
    return empty;
  }

  const sized = await Promise.all(
    names.map(async (name) => {
      try {
        const info = await stat(join(path, name));
        return info.isFile() ? { name, bytes: info.size } : null;
      } catch {
        return null;
      }
    }),
  );

  const files = sized.filter((f): f is { name: string; bytes: number } => !!f);
  const byScope: StoreReport["byScope"] = {};
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.bytes;
    const prefix = scopePrefix(file.name);
    const bucket = byScope[prefix] ?? { files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += file.bytes;
    byScope[prefix] = bucket;
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
  };
}

function resolveStoreDataDir(override?: string): {
  dataDir: string;
  dataDirSource: StoreDiagnostics["dataDirSource"];
  dataDirCandidates: string[];
} {
  if (override) {
    return {
      dataDir: override,
      dataDirSource: "override",
      dataDirCandidates: [override],
    };
  }

  let resolved: string | null = null;
  try {
    resolved = resolveDataDir().dataDir;
  } catch {
    resolved = null;
  }

  const candidates = [resolved, DEPLOY_DATA_DIR].filter(
    (c): c is string => !!c,
  );
  const sources: Array<StoreDiagnostics["dataDirSource"]> = resolved
    ? ["resolver", "deploy-default"]
    : ["deploy-default"];

  for (let i = 0; i < candidates.length; i++) {
    if (existsSync(join(candidates[i]!, STATE_STORE))) {
      return {
        dataDir: candidates[i]!,
        dataDirSource: sources[i]!,
        dataDirCandidates: candidates,
      };
    }
  }

  // Nothing held a store. Report the first candidate anyway so the
  // response shows an empty store at a named path rather than an
  // unexplained zero.
  return {
    dataDir: candidates[0] ?? DEPLOY_DATA_DIR,
    dataDirSource: "unresolved",
    dataDirCandidates: candidates,
  };
}

async function readVmRss(procDir: string): Promise<number | null> {
  const status = await readFile(join(procDir, "status"), "utf-8");
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return match ? parseInt(match[1]!, 10) * 1024 : null;
}

// The engine pid file (src/cli.ts) is not usable here: the Railway
// entrypoint runs as root and execs `gosu node:node`, which leaves
// HOME=/root, so the CLI's write to ~/.agentmemory/iii.pid fails EACCES
// and is swallowed. lsof is absent from that image too, so the port
// lookup returns nothing. /proc is what the plan's own fallback
// one-liner reads, and the iii / iii-* name test is the same one
// adoptRunningEngine uses before it will adopt a pid.
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
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const procDir = join(procRoot, entry);
    let comm: string;
    try {
      comm = await readFile(join(procDir, "comm"), "utf-8");
    } catch {
      continue;
    }
    if (!isEngineComm(comm)) continue;
    let rssBytes: number | null = null;
    try {
      rssBytes = await readVmRss(procDir);
    } catch {
      rssBytes = null;
    }
    processes.push({ pid: parseInt(entry, 10), comm: comm.trim(), rssBytes });
  }

  if (processes.length === 0) {
    return {
      processes,
      unavailable: `no iii engine process found under ${procRoot}`,
    };
  }
  return { processes };
}

async function readCgroupCurrent(): Promise<{
  bytes: number | null;
  unavailable?: string;
}> {
  const paths = [
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ];
  const failures: string[] = [];
  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf-8");
      const bytes = parseInt(raw.trim(), 10);
      if (Number.isFinite(bytes)) return { bytes };
      failures.push(`${path}: not a number`);
    } catch (err) {
      failures.push(`${path}: ${reason(err)}`);
    }
  }
  return { bytes: null, unavailable: failures.join("; ") };
}

// `overrides` exists so the /proc and store reads are drivable from a
// temp directory. Without it the engine half is only exercised on Linux
// with a live engine, which is neither the test host nor CI — and that
// is precisely the half carrying VmRSS, the number every gate's k is
// computed from.
export function registerDiagnosticsStoreFunction(
  sdk: ISdk,
  overrides: { dataDir?: string; procRoot?: string } = {},
): void {
  const procRoot = overrides.procRoot ?? "/proc";
  sdk.registerFunction(
    "mem::diagnostics-store",
    async (): Promise<StoreDiagnostics> => {
      const at = new Date().toISOString();
      const { dataDir, dataDirSource, dataDirCandidates } = resolveStoreDataDir(
        overrides.dataDir,
      );

      const [state, stream, engine, cgroup] = await Promise.all([
        readStoreDir(join(dataDir, STATE_STORE)),
        readStoreDir(join(dataDir, STREAM_STORE)),
        findEngineProcesses(procRoot),
        readCgroupCurrent(),
      ]);

      let nodeRssBytes: number | null = null;
      let nodeRssUnavailable: string | undefined;
      try {
        nodeRssBytes = await readVmRss(join(procRoot, "self"));
      } catch (err) {
        nodeRssUnavailable = reason(err);
      }

      const engineRss = engine.processes.reduce<number | null>(
        (sum, proc) =>
          proc.rssBytes === null ? sum : (sum ?? 0) + proc.rssBytes,
        null,
      );

      return {
        success: true,
        at,
        dataDir,
        dataDirSource,
        dataDirCandidates,
        stores: { state, stream },
        process: {
          node: {
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime()),
            rssBytes: nodeRssBytes,
            ...(nodeRssUnavailable
              ? { rssUnavailable: nodeRssUnavailable }
              : {}),
          },
          engine: {
            rssBytes: engineRss,
            processes: engine.processes,
            ...(engine.unavailable ? { unavailable: engine.unavailable } : {}),
          },
          cgroupCurrentBytes: cgroup.bytes,
          ...(cgroup.unavailable
            ? { cgroupUnavailable: cgroup.unavailable }
            : {}),
        },
        index: {
          bm25Entries: getSearchIndex().size,
          vectorEntries: getVectorIndex()?.size ?? null,
        },
      };
    },
  );
}
