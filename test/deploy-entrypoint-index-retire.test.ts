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
import { fileURLToPath } from "node:url";

// INDEX_GENERATIONS_RETIRE_AT_BOOT retires every BM25 and vector generation the
// index manifest does not name as live. The engine percent-encodes ":" when it
// names a scope file, so the retire has to spell the names that way or it moves
// nothing, which is exactly what happened to U6's audit retire.
//
// These run the real Railway entrypoint rather than an extracted function, so
// the flag gate and the ordering ahead of the engine config are the ones that
// ship. The script runs under `set -eu` and, after the retire steps, writes
// the iii config under /opt/agentmemory, which does not exist here, so it
// exits non-zero. The retire effects are read off the filesystem and stdout
// either way. chown and gosu are stubbed on PATH. deploy-entrypoint-drift
// holds the other three targets to the same body.

const ENTRYPOINT = fileURLToPath(
  new URL("../deploy/railway/entrypoint.sh", import.meta.url),
);

let dir: string;
const dataDir = () => join(dir, "data");
const storeDir = () => join(dataDir(), "state_store.db");
const retiredRoot = () => join(dataDir(), "retired");

function stub(name: string, body = "exit 0") {
  writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function boot(extra: Record<string, string> = {}): string {
  const env = {
    PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: dir,
    AGENTMEMORY_DATA_DIR: dataDir(),
    AGENTMEMORY_HMAC_FILE: join(dataDir(), ".hmac"),
    ...extra,
  };
  try {
    return execFileSync("sh", [ENTRYPOINT], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
}

function retiredFiles(): string[] {
  if (!existsSync(retiredRoot())) return [];
  return readdirSync(retiredRoot())
    .flatMap((stamp) => readdirSync(join(retiredRoot(), stamp)))
    .sort();
}

function seed(name: string, bytes: number) {
  writeFileSync(join(storeDir(), name), Buffer.alloc(bytes));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "am-entry-scope-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(storeDir(), { recursive: true });
  stub("chown");
  stub("gosu");
  // `date` counts its calls instead of reading the clock, so a retire stamp is
  // the number of times the script asked for one. A helper that stamps per call
  // then puts every file in its own directory on every run, and the one-stamp
  // assertion below fails it every time, not only when the loop straddles a
  // second boundary.
  stub("date", [
    'n=$(($(cat "$HOME/.date-calls" 2>/dev/null || echo 0) + 1))',
    'echo "$n" > "$HOME/.date-calls"',
    'printf "20260906T%06dZ\\n" "$n"',
  ].join("\n"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the harness reaches the retire steps", () => {
  // Positive control: U2's stream retire runs first and is already shipped,
  // so its log line proves the script got past the chown stub and into the
  // retire block. Without this, "nothing was retired" could mean the script
  // died on line one.
  it("sees U2 retire a stream file", () => {
    mkdirSync(join(dataDir(), "stream_store"));
    writeFileSync(join(dataDir(), "stream_store", "ses_abc.bin"), Buffer.alloc(4));

    const out = boot();

    expect(out).toContain("retired 1 stream file(s), 4 bytes");
  });
});

// Lever b' of the memory-reduction loop, generalised: every index generation the
// manifest does not name as live is retired at boot. Why the manifest is the
// selector, and where the on-disk format below comes from, are in "Why the
// manifest, not a list" in
// docs/investigations/2026-09-06-reclaim-orphaned-generations-rebase.md.
//
// The names matter more here than anywhere else in this file. A generation's
// shards are one scope each and the engine writes one file per scope:
//
//   mem%3Aindex%3Abm25%3A<family>%3Aidx_<id>_<hex>%3A<NNNNN>.bin
//
// <family> is bm25 or vectors, <hex> is minted with the id, <NNNNN> is the shard
// number. The diagnostics endpoint groups those names by splitting on [:_],
// which is why byScope reports `mem:index:bm25:bm25:idx:mtj0pzb2`. That grouping
// key is not a filename and matches nothing on disk. That is why the loop calls
// retire_matching_file, which takes a filename: neither the hex suffix nor the
// shard number is known before the glob runs.
const MANIFEST_FILE = "mem%3Aindex%3Abm25.bin";

const LIVE_BM25 = "idx_mtow4iaa_1111aaaa2222";
const LIVE_VEC = "idx_mtow62p9_3333bbbb4444";
const DEAD_BM25 = [
  "idx_mtj0pzb2_73ee689c0219",
  "idx_mtlwdg4b_4d6f0fb52cfe",
  "idx_mtohwasy_5555cccc6666",
  "idx_mtorf55a_7777dddd8888",
  "idx_mtnp1c9s_3698dd9cd6e0",
];

const shardName = (family: string, gen: string, shard: string) =>
  `mem%3Aindex%3Abm25%3A${family}%3A${gen}%3A${shard}.bin`;

const deadFiles = () => DEAD_BM25.map((g) => shardName("bm25", g, "00000"));
const liveFiles = () => [
  shardName("bm25", LIVE_BM25, "00000"),
  shardName("bm25", LIVE_BM25, "00001"),
  shardName("vectors", LIVE_VEC, "00000"),
];

// The engine pads the JSON body to a 4-byte boundary and appends rkyv's 8-byte
// string root: the body length as a little-endian u32, then the negative relative
// pointer. A body length ≡ 125 (mod 256) puts 0x7d in the length's low byte, so
// the last "}" in the file is a trailer byte and not the body's closing brace.
function rkyvFrame(body: Buffer): Buffer {
  const pad = (4 - (body.length % 4)) % 4;
  const root = Buffer.alloc(8);
  root.writeUInt32LE(body.length, 0);
  root.writeInt32LE(-(body.length + pad + 4), 4);
  return Buffer.concat([body, Buffer.alloc(pad), root]);
}

// The engine writes a scope as its JSON object from offset 0 followed by a short
// rkyv trailer, so the JSON body is data[0 .. rfind("}") + 1]. The trailer is
// seeded here so the reader is exercised against the real shape and not against
// clean JSON.
function seedManifest(
  live: Record<string, string> = { "data:manifest": LIVE_BM25, "vectors:manifest": LIVE_VEC },
  { encodeValues = false, trailer = true, collide = false } = {},
) {
  const scope: Record<string, unknown> = {
    // The gc ledger shares this scope file, under `${manifestKey}:gc`. It names
    // every orphan, which is why the live id is read from the two manifest keys
    // by name and never by grepping the file for an id.
    "data:manifest:gc": {
      v: 1,
      generations: [...DEAD_BM25, LIVE_BM25].map((generation) => ({
        generation,
        shards: [{ scope: `mem:index:bm25:bm25:${generation}:00000`, key: "data" }],
      })),
    },
  };
  for (const [key, generation] of Object.entries(live)) {
    const value = {
      v: 1,
      shards: [{ scope: `mem:index:bm25:${key.split(":")[0]}:${generation}:00000`, key: "data", chars: 9 }],
      generation,
    };
    scope[key] = encodeValues ? JSON.stringify(value) : value;
  }
  if (collide) {
    // `,"pad":""` costs 9 bytes, so the filler is what lands the body in the class.
    const bare = Buffer.byteLength(JSON.stringify(scope)) + 9;
    scope["pad"] = "x".repeat((125 - (bare % 256) + 256) % 256);
  }
  const body = Buffer.from(JSON.stringify(scope), "utf8");
  let file = trailer ? Buffer.concat([body, Buffer.from([0, 1, 2, 3])]) : body;
  if (collide) file = rkyvFrame(body);
  writeFileSync(join(storeDir(), MANIFEST_FILE), file);
}

const genSize = (i: number) => 300 + i;

function seedGenerations() {
  [...deadFiles(), ...liveFiles()].forEach((f, i) => seed(f, genSize(i)));
  seed("mem%3Amemories.bin", 8);
}

// The dead shards are the leading entries of the array seedGenerations walks, so
// their sizes are the first deadFiles().length values of genSize. Derived rather
// than written out, so changing the fixture cannot leave the total stale.
const deadBytes = () => deadFiles().reduce((n, _f, i) => n + genSize(i), 0);

describe("entrypoint retires index generations the manifest does not name", { timeout: 20000 }, () => {
  it("moves the five dead generations and leaves the live one", () => {
    seedGenerations();
    seedManifest();

    const out = boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(retiredFiles()).toEqual(deadFiles().sort());
    expect(readdirSync(storeDir()).sort()).toEqual(
      [...liveFiles(), MANIFEST_FILE, "mem%3Amemories.bin"].sort(),
    );
    // One summary line for the whole retire, the shape retire_stream_files uses.
    // A per-file line does not survive a 148-shard retire in a log tail.
    expect(out).toContain(
      `retired ${deadFiles().length} index shard(s), ${deadBytes()} bytes, to `,
    );
  });

  it("reads a manifest whose values are JSON-encoded strings", () => {
    seedGenerations();
    seedManifest(undefined, { encodeValues: true });

    boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(retiredFiles()).toEqual(deadFiles().sort());
  });

  it("is idempotent: a second boot finds nothing and logs nothing", () => {
    seedGenerations();
    seedManifest();
    boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });
    const after = retiredFiles();

    const out = boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(out).not.toContain("index shard(s)");
    expect(retiredFiles()).toEqual(after);
    // Anchor the run this one is idempotent against: without it "no worse than
    // run one" also holds when run one moved nothing. The directory count is the
    // other half, because retiredFiles() flat-maps stamps to files and an empty
    // stamp directory contributes nothing to it.
    expect(after).toEqual(deadFiles().sort());
    expect(readdirSync(retiredRoot())).toHaveLength(1);
  });

  // Fail closed. Without a manifest nothing on disk can be told live from dead,
  // and retiring the live index costs a full-corpus rebuild, so the absent
  // manifest moves nothing and says so once. It is silent about which files it
  // did not move: on a real store that is every shard.
  it("moves nothing and logs once when the manifest file is absent", () => {
    seedGenerations();

    const out = boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    // The absent case names the absence. A fresh volume has no index yet, and an
    // operator reading this line needs to tell that from a read that failed.
    expect(out).toContain(
      "index generation retire skipped, no mem%3Aindex%3Abm25.bin on disk",
    );
    expect(out.match(/index generation retire skipped/g)).toHaveLength(1);
    expect(existsSync(retiredRoot())).toBe(false);
    expect(readdirSync(storeDir()).sort()).toEqual(
      [...deadFiles(), ...liveFiles(), "mem%3Amemories.bin"].sort(),
    );
  });

  it("moves nothing when the manifest is present but unparseable", () => {
    seedGenerations();
    writeFileSync(join(storeDir(), MANIFEST_FILE), Buffer.from("not json at all"));

    const out = boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    // A present-but-unreadable manifest is the signal that the reader's
    // assumption about the engine's on-disk shape stopped holding, so it must
    // not read the same as an absent one.
    expect(out).toContain(
      "index generation retire skipped, no live generation read from mem%3Aindex%3Abm25.bin",
    );
    expect(out).not.toContain("no mem%3Aindex%3Abm25.bin on disk");
    expect(existsSync(retiredRoot())).toBe(false);
  });

  // The reader's guard is on the whole read. A manifest that parses but names
  // no generation must take the same skip as an unparseable one: without the
  // guard the reader prints an empty list, which is non-empty to the shell, and
  // every generation on disk reads as dead.
  it("moves nothing when the manifest parses but names no generation", () => {
    seedGenerations();
    seedManifest({});

    const out = boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(out).toContain(
      "index generation retire skipped, no live generation read from mem%3Aindex%3Abm25.bin",
    );
    expect(existsSync(retiredRoot())).toBe(false);
  });

  // The trailer encodes the body length, so a body length ≡ 125 (mod 256) puts
  // 0x7d in the length's low byte and the file's last "}" is a trailer byte. The
  // reader retries from the brace before it, so a healthy store in that class is
  // read rather than skipped. The fixture sits at the tightest case: the body's
  // brace lands exactly on the raw.length - 12 bound the retry stops at.
  it("reads a manifest whose rkyv trailer carries a 0x7d", () => {
    seedGenerations();
    seedManifest(undefined, { collide: true });

    const out = boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(retiredFiles()).toEqual(deadFiles().sort());
    expect(out).not.toContain("index generation retire skipped");
  });

  // The gate is the literal "true", the same shape as GRAPH_SCOPES_RETIRE_AT_BOOT,
  // so an unset flag and a stray value both leave the store alone. The flag no
  // longer carries a list: a per-boot growth term outruns any list written ahead
  // of the boot.
  it("moves nothing when the flag is unset or is any value but true", () => {
    seedGenerations();
    seedManifest();

    const unset = boot();
    const other = boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "1" });

    expect(unset).not.toContain("index shard(s)");
    expect(unset).not.toContain("index generation retire skipped");
    expect(other).not.toContain("index shard(s)");
    expect(existsSync(retiredRoot())).toBe(false);
  });

  // Each family's live id comes from its own manifest key, and the fail-closed
  // guard is on the whole read, not per family. A family whose key is missing
  // has no live id, so its one generation is retired: the per-family fail-open.
  it("retires the vector generation when only the BM25 manifest names one", () => {
    seedGenerations();
    seedManifest({ "data:manifest": LIVE_BM25 });

    boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(retiredFiles()).toContain(shardName("vectors", LIVE_VEC, "00000"));
  });

  // The live test is an exact-element test against a pipe-delimited list, not a
  // substring test. Dropping the "|" delimiters turns it into one, and a dead
  // generation whose id is a substring of a live id then survives the retire,
  // which is the failure the delimiters exist to stop.
  //
  // Unreachable on today's ids, which is why it is a fixture and not a bug.
  // generateId mints idx_ + Date.now().toString(36) + _ + 12 hex, and the base-36
  // timestamp is a fixed 8 characters until roughly 2059, so every id is the same
  // length and none is a strict prefix of another.
  it("retires a dead generation whose id neighbours a live id by substring", () => {
    const contained = LIVE_BM25.slice(0, -1);
    seedGenerations();
    seed(shardName("bm25", contained, "00000"), 400);
    seedManifest();

    boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(retiredFiles()).toContain(shardName("bm25", contained, "00000"));
    expect(existsSync(join(storeDir(), shardName("bm25", LIVE_BM25, "00000")))).toBe(true);
  });
});

// retire_matching_file is shared, and this branch changed it. The two audit
// calls at the top of the entrypoint leave _retire_dest unset and still take
// the production path: their own stamped directory and one line each. The index
// loop sets it and takes the other path: one directory for the whole run,
// counted rather than echoed. Nothing tested either half. Replacing the
// per-file echo with `:` left the whole suite green.
describe("the shared retire helper keeps both of its modes", { timeout: 20000 }, () => {
  it("leaves _retire_dest unset: own stamp directory, one line per file", () => {
    seed("mem:audit.bin", 4);

    const out = boot();

    // `wc -c < file` pads the number on BSD, so the count is matched with a run
    // of spaces rather than one.
    expect(out).toMatch(/retired mem:audit\.bin, +4 bytes, to /);
    expect(retiredFiles()).toEqual(["mem:audit.bin"]);
  });

  it("sets _retire_dest: one directory for the run, counted not echoed", () => {
    seedGenerations();
    seedManifest();

    const out = boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    // One stamp for the whole loop. Nothing else here writes under retired/:
    // no stream file and no audit file is seeded.
    expect(readdirSync(retiredRoot())).toHaveLength(1);
    expect(out).not.toMatch(/retired mem%3Aindex/);
  });
});
