import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
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
