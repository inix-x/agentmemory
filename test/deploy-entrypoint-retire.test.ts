import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// U2 of the memory-reduction ladder retires the stream store at boot, from
// inside the deploy entrypoints. A defect there is not a failed test, it is a
// container that does not start -- the script runs under `set -eu`, so any
// non-zero exit kills the boot before the engine is reached.
//
// The plan recorded "no unit-test harness" for this, which was true of the file
// as a whole but not of the function: it takes a directory and is pure shell, so
// it runs against a temp fixture. This extracts the real function from the real
// entrypoint rather than restating it, so the test cannot pass against a copy
// that has drifted from what ships.

const entrypoint = (target: string) =>
  readFileSync(
    fileURLToPath(new URL(`../deploy/${target}/entrypoint.sh`, import.meta.url)),
    "utf8",
  );

function extractFn(target: string): string {
  const src = entrypoint(target);
  const start = src.indexOf("retire_stream_files() {");
  const end = src.indexOf("\n}", start);
  expect(start, `${target}: retire_stream_files not found`).toBeGreaterThan(-1);
  return src.slice(start, end + 2);
}

let dir: string;

/** Runs the shipped function against `dir`, under the entrypoint's own `set -eu`. */
function runRetire(target = "railway"): { stdout: string; status: number } {
  const script = [
    "set -eu",
    `DATA_DIR="${join(dir, "data")}"`,
    'RUN_AS="$(id -u):$(id -g)"',
    extractFn(target),
    'retire_stream_files "$DATA_DIR/stream_store"',
    'echo "__done__"',
  ].join("\n");
  const stdout = execFileSync("sh", ["-c", script], { encoding: "utf8" });
  return { stdout, status: stdout.includes("__done__") ? 0 : 1 };
}

const streamDir = () => join(dir, "data", "stream_store");
const retiredRoot = () => join(dir, "data", "retired");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "am-entry-"));
  mkdirSync(streamDir(), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("entrypoint retires the stream store", () => {
  it("moves session-group files and keeps the viewer group", () => {
    writeFileSync(join(streamDir(), "ses_abc.bin"), Buffer.alloc(4));
    writeFileSync(join(streamDir(), "ses_def.bin"), Buffer.alloc(6));
    writeFileSync(join(streamDir(), "mem-live_viewer.bin"), Buffer.alloc(2));

    const { stdout, status } = runRetire();

    expect(status).toBe(0);
    expect(stdout).toContain("retired 2 stream file(s), 10 bytes");
    // The viewer group is what the dashboard subscribes to; losing it costs the
    // live feed, while keeping a session file only costs bytes.
    expect(readdirSync(streamDir())).toEqual(["mem-live_viewer.bin"]);

    const stamps = readdirSync(retiredRoot());
    expect(stamps).toHaveLength(1);
    expect(readdirSync(join(retiredRoot(), stamps[0]!)).sort()).toEqual([
      "ses_abc.bin",
      "ses_def.bin",
    ]);
  });

  it("is idempotent: a second boot moves nothing and logs nothing", () => {
    writeFileSync(join(streamDir(), "ses_abc.bin"), Buffer.alloc(4));
    runRetire();
    const afterFirst = readdirSync(retiredRoot());

    const { stdout, status } = runRetire();

    expect(status).toBe(0);
    expect(stdout).not.toContain("retired");
    // No second timestamped directory, so every deploy after the first is silent.
    expect(readdirSync(retiredRoot())).toEqual(afterFirst);
  });

  it("survives a missing stream store", () => {
    rmSync(streamDir(), { recursive: true, force: true });

    const { stdout, status } = runRetire();

    expect(status).toBe(0);
    expect(stdout).not.toContain("retired");
  });

  it("creates no retired directory when there is nothing to move", () => {
    const { status } = runRetire();

    expect(status).toBe(0);
    expect(existsSync(retiredRoot())).toBe(false);
  });

  it("leaves subdirectories alone", () => {
    mkdirSync(join(streamDir(), "nested"));
    writeFileSync(join(streamDir(), "ses_abc.bin"), Buffer.alloc(4));

    const { status } = runRetire();

    expect(status).toBe(0);
    expect(readdirSync(streamDir())).toEqual(["nested"]);
  });

  it("ships the same function on every deploy target", () => {
    // The four entrypoints are copies, so this is the one place a target could
    // silently miss the change.
    for (const target of ["railway", "render", "coolify", "fly"]) {
      expect(extractFn(target), target).toBe(extractFn("railway"));
    }
  });
});

// KTD4, KTD5, and KTD10 of the 2026-10-30 fork-sync plan. These boot the real
// Railway entrypoint, like deploy-entrypoint-index-retire, so the flag gates and
// their order against the chown, the flagless retires, and the engine start are
// the ones that ship. Past the retire steps the script writes the iii config
// under /opt/agentmemory, which does not exist here, so a non-held boot exits
// non-zero; its effects are read off the filesystem and stdout either way.
// deploy-entrypoint-drift holds the other three targets to the same body.
describe("the last fork boot before the upstream cutover", { timeout: 20000 }, () => {
  const ENTRYPOINT = fileURLToPath(
    new URL("../deploy/railway/entrypoint.sh", import.meta.url),
  );
  const dataDir = () => join(dir, "data");
  const storeDir = () => join(dataDir(), "state_store.db");
  const enc = (scope: string) => `${scope.replace(/:/g, "%3A")}.bin`;

  const CUTOVER = [
    "mem:graph:nodes",
    "mem:graph:edges",
    "mem:graph:snapshot",
    "mem:graph:name-index",
    "mem:graph:edge-key",
    "mem:graph:node-degree",
    "mem:graph:adj",
    "mem:graph:names",
    "mem:graph:batches",
    "mem:graph:obs-index",
    "mem:audit",
  ].map(enc);
  // Near-misses a loose match would take: the audit month partitions KTD5
  // keeps, a graph-prefixed scope outside the ten, and unrelated live scopes.
  const KEEP = [
    "mem:audit:2026-09",
    "mem:audit:months",
    "mem:graph:nodes-extra",
    "mem:obs:ses_abc",
    "mem:memories",
  ].map(enc);

  function stub(name: string, body = "exit 0") {
    writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  function bootEnv(extra: Record<string, string> = {}) {
    return {
      PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: dir,
      AGENTMEMORY_DATA_DIR: dataDir(),
      AGENTMEMORY_HMAC_FILE: join(dataDir(), ".hmac"),
      ...extra,
    };
  }

  function boot(extra: Record<string, string> = {}): string {
    try {
      return execFileSync("sh", [ENTRYPOINT], {
        encoding: "utf8",
        env: bootEnv(extra),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return (err as { stdout?: string }).stdout ?? "";
    }
  }

  const retiredRoot = () => join(dataDir(), "retired");
  const stamps = () => (existsSync(retiredRoot()) ? readdirSync(retiredRoot()) : []);

  function seedStore() {
    CUTOVER.forEach((f, i) => writeFileSync(join(storeDir(), f), Buffer.alloc(i + 1)));
    KEEP.forEach((f) => writeFileSync(join(storeDir(), f), Buffer.alloc(3)));
  }

  beforeEach(() => {
    mkdirSync(join(dir, "bin"));
    mkdirSync(storeDir(), { recursive: true });
    stub("chown");
    stub("gosu", 'touch "$HOME/.gosu-ran"');
    // Counts calls instead of reading the clock, so a per-scope stamp shows up
    // as eleven directories instead of hiding inside one second.
    stub("date", [
      'n=$(($(cat "$HOME/.date-calls" 2>/dev/null || echo 0) + 1))',
      'echo "$n" > "$HOME/.date-calls"',
      'printf "20261030T%06dZ\\n" "$n"',
    ].join("\n"));
  });

  it("moves the 11 cutover files into one stamp and keeps the rest", () => {
    seedStore();

    const out = boot({ CUTOVER_RETIRE_AT_BOOT: "true" });

    expect(readdirSync(storeDir()).sort()).toEqual([...KEEP].sort());
    expect(stamps()).toHaveLength(1);
    expect(readdirSync(join(retiredRoot(), stamps()[0]!)).sort()).toEqual(
      [...CUTOVER].sort(),
    );
    // One line per moved file, with its name and byte count, then a total.
    CUTOVER.forEach((f, i) =>
      expect(out).toContain(`cutover retired ${f}, ${i + 1} bytes, to `),
    );
    expect(out).toContain("cutover retired 11 scope file(s), 66 bytes, to ");
  });

  it("moves nothing with the flag unset or not the literal true", () => {
    seedStore();

    boot();
    boot({ CUTOVER_RETIRE_AT_BOOT: "1" });

    expect(readdirSync(storeDir()).sort()).toEqual([...CUTOVER, ...KEEP].sort());
    expect(stamps()).toEqual([]);
  });

  it("is clean on a second boot after the files are gone", () => {
    // boot() swallows the exit code, so "nothing logged" alone cannot tell a
    // clean pass from a block that died under set -eu. The index retire runs
    // after the cutover block and, with no manifest seeded, prints its skip
    // line: seeing it proves the script got through.
    const flags = { CUTOVER_RETIRE_AT_BOOT: "true", INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" };
    const reached = "index generation retire skipped, no mem%3Aindex%3Abm25.bin on disk";
    seedStore();
    expect(boot(flags)).toContain(reached);
    const afterFirst = stamps();

    const out = boot(flags);

    expect(out).toContain(reached);
    expect(out).not.toContain("cutover retired");
    expect(stamps()).toEqual(afterFirst);
    expect(readdirSync(storeDir()).sort()).toEqual([...KEEP].sort());
  });

  it("leaves GRAPH_ROWS_REWRITE_AT_BOOT's six-scope retire as it was", () => {
    seedStore();

    boot({ GRAPH_ROWS_REWRITE_AT_BOOT: "1" });

    const moved = stamps().flatMap((s) => readdirSync(join(retiredRoot(), s)));
    expect(moved.sort()).toEqual(CUTOVER.slice(0, 6).sort());
  });

  /** Every path under /data with its size and mtime, so any write shows. */
  function snapshot(root: string): string[] {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .map((e) => {
        const p = join(e.parentPath, e.name);
        const s = statSync(p);
        return `${p.slice(root.length)} ${e.isDirectory() ? "d" : s.size} ${s.mtimeMs}`;
      })
      .sort();
  }

  function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const port = (srv.address() as AddressInfo).port;
        srv.close(() => resolve(port));
      });
    });
  }

  it("DATA_HOLD starts no engine, changes nothing under /data, and answers the healthcheck", async () => {
    // Every flag that moves a file is on, and every kind of file is seeded, so a
    // hold placed below any of them fails here.
    seedStore();
    writeFileSync(join(dataDir(), "stream_store", "ses_abc.bin"), Buffer.alloc(4));
    writeFileSync(join(storeDir(), "mem%3Aindex%3Abm25.bin"), Buffer.alloc(5));
    const before = snapshot(dataDir());
    const port = await freePort();

    const child = spawn("sh", [ENTRYPOINT], {
      env: bootEnv({
        DATA_HOLD: "true",
        CUTOVER_RETIRE_AT_BOOT: "true",
        INDEX_GENERATIONS_RETIRE_AT_BOOT: "true",
        GRAPH_ROWS_REWRITE_AT_BOOT: "1",
        PORT: String(port),
      }),
      stdio: "ignore",
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      let live: Response | undefined;
      for (let i = 0; i < 100 && !live; i++) {
        live = await fetch(`${base}/agentmemory/livez`).catch(() => undefined);
        if (!live) await new Promise((r) => setTimeout(r, 50));
      }
      expect(live?.status).toBe(200);
      const write = await fetch(`${base}/agentmemory/remember`, { method: "POST" });
      expect(write.status).toBe(503);

      expect(existsSync(join(dir, ".gosu-ran"))).toBe(false);
      expect(snapshot(dataDir())).toEqual(before);
    } finally {
      child.kill("SIGTERM");
    }
  });
});
