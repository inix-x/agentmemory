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

function stub(name: string) {
  writeFileSync(join(dir, "bin", name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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

// Lever b' of the memory-reduction loop, generalised. Index persistence mints a
// generation per boot and the manifest-driven GC does not reclaim the prior one,
// so a sandbox with 20 redeploys in a day carried six BM25 generations totalling
// 1,104 MiB with one live at ~257 MiB: ~847 MiB of dead index, larger than any
// single lever in the composition table (21:32Z census, experiment log).
// Retiring a named list does not keep up with a per-boot growth term, so the
// selector is "every generation the manifest does not name as live".
//
// The names matter more here than anywhere else in this file. A generation's
// shards are one scope each and the engine writes one file per scope:
//
//   mem%3Aindex%3Abm25%3A<family>%3Aidx_<id>_<hex>%3A<NNNNN>.bin
//
// <family> is bm25 or vectors, <hex> is minted with the id, <NNNNN> is the shard
// number. The diagnostics endpoint groups those names by splitting on [:_],
// which is why byScope reports `mem:index:bm25:bm25:idx:mtj0pzb2`. That grouping
// key is not a filename and matches nothing on disk. retire_scope cannot spell
// these either: it encodes a literal scope name, and neither the hex suffix nor
// the shard number is known before the glob runs.
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

// The engine writes a scope as rkyv::to_bytes(KeyStorage(serde_json::to_string(
// scope_map))): the scope's JSON object as raw bytes from offset 0, then a short
// rkyv trailer, so the JSON body is data[0 .. rfind("}") + 1]
// (docs/plans/2026-09-06-001-graph-memory-redesign-plan.md Appendix, verified
// against both graph scope files to within one byte). The trailer is seeded here
// so the reader is exercised against the real shape and not against clean JSON.
function seedManifest(
  live: Record<string, string> = { "data:manifest": LIVE_BM25, "vectors:manifest": LIVE_VEC },
  { encodeValues = false, trailer = true } = {},
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
  const body = Buffer.from(JSON.stringify(scope), "utf8");
  writeFileSync(
    join(storeDir(), MANIFEST_FILE),
    trailer ? Buffer.concat([body, Buffer.from([0, 1, 2, 3])]) : body,
  );
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

  // Both manifests are read, so the live vector generation survives even though
  // the vector family has exactly one generation and no BM25 shard names it.
  it("retires the vector generation when only the BM25 manifest names one", () => {
    seedGenerations();
    seedManifest({ "data:manifest": LIVE_BM25 });

    boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(retiredFiles()).toContain(shardName("vectors", LIVE_VEC, "00000"));
  });

  // The live test is an exact-element test against a pipe-delimited list, not a
  // substring test. Dropping the "|" delimiters turns it into one, and a dead
  // generation whose id is a substring of a live id then survives the retire,
  // which is the failure the delimiters exist to stop. Both neighbouring shapes
  // are seeded: an id the live id contains, and an id that contains the live id.
  // Only the first can be kept by a substring test, and it is the one that makes
  // the delimiters load-bearing.
  //
  // Unreachable on today's ids, which is why it is a fixture and not a bug.
  // generateId mints idx_ + Date.now().toString(36) + _ + 12 hex, and the base-36
  // timestamp is a fixed 9 characters until roughly 2059, so every id is the same
  // length and none is a strict prefix of another.
  it("retires a dead generation whose id neighbours a live id by substring", () => {
    const contained = LIVE_BM25.slice(0, -1);
    const containing = `${LIVE_BM25}_9999eeee0000`;
    seedGenerations();
    seed(shardName("bm25", contained, "00000"), 400);
    seed(shardName("bm25", containing, "00000"), 401);
    seedManifest();

    boot({ INDEX_GENERATIONS_RETIRE_AT_BOOT: "true" });

    expect(retiredFiles()).toContain(shardName("bm25", contained, "00000"));
    expect(retiredFiles()).toContain(shardName("bm25", containing, "00000"));
    expect(existsSync(join(storeDir(), shardName("bm25", LIVE_BM25, "00000")))).toBe(true);
  });
});
