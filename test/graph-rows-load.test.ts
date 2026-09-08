import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphRowsLoadFunction } from "../src/functions/graph-rows-load.js";
import { readAdj, readObsIndex } from "../src/state/graph-store.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphSnapshot } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

// The other half of GRAPH_ROWS_REWRITE_AT_BOOT. The entrypoint retired the six
// originals before the engine started; this puts the emitter's output back
// through the verbatim row importer, one kv.set per row, so the engine writes
// its own format (KTD3).
//
// The fixture runs the real emitter rather than hand-writing its output: a
// loader tested against a hand-made stream proves nothing about the pair.

const TOOL = new URL("../scripts/graph-rewrite/rewrite.py", import.meta.url)
  .pathname;
const RESET_AT = "2026-09-02T19:50:03.637Z";

let dir: string;
let sdk: ReturnType<typeof mockSdk>;
let kv: ReturnType<typeof mockKV>;

const writeBin = (name: string, scopeMap: Record<string, unknown>) => {
  const path = join(dir, name);
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(JSON.stringify(scopeMap), "utf8"),
      Buffer.from([0x00, 0x01]),
    ]),
  );
  return path;
};

const node = (id: string, name: string, createdAt: string, obs: string[]) => ({
  id,
  type: "concept",
  name,
  properties: {},
  sourceObservationIds: obs,
  createdAt,
});

const edge = (id: string, src: string, tgt: string, createdAt: string) => ({
  id,
  type: "related_to",
  sourceNodeId: src,
  targetNodeId: tgt,
  weight: 1,
  sourceObservationIds: ["o1"],
  createdAt,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "u2-load-"));
  sdk = mockSdk();
  kv = mockKV();
  vi.clearAllMocks();
  registerGraphRowsLoadFunction(sdk as never, kv as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The emitter's default is keep (KTD-R1), so drop is passed explicitly rather
// than relied on. Every assertion below about gn_orphan being absent is an
// assertion about drop mode, and a silent default flip would turn them into
// assertions about nothing.
const emit = (mode: "keep" | "drop" = "drop") => {
  const snap = writeBin("snap.bin", {
    current: { version: 1, resetAt: RESET_AT },
  });
  const nodes = writeBin("nodes.bin", {
    gn_a: node("gn_a", "Alpha", "2026-09-03T00:00:00Z", ["o1"]),
    gn_b: node("gn_b", "Beta", "2026-09-03T00:00:00Z", ["o1"]),
    gn_orphan: node("gn_orphan", "Gone", "2026-09-01T00:00:00Z", ["o9"]),
    // A pre-reset twin of Alpha, deliberately LAST in .bin order. The writer's
    // reset path mints a fresh node for a name whose index hit is pre-reset
    // (graph.ts:1144-1156), so on production every post-reset node has one.
    gn_twin: node("gn_twin", "Alpha", "2026-09-01T00:00:00Z", ["o9"]),
  });
  const edges = writeBin("edges.bin", {
    ge_1: edge("ge_1", "gn_a", "gn_b", "2026-09-03T00:00:00Z"),
  });
  const out = join(dir, "out");
  for (const [scope, bin] of [
    ["nodes", nodes],
    ["edges", edges],
  ] as const) {
    execFileSync("python3", [
      TOOL,
      "--scope", scope,
      "--bin", bin,
      "--snapshot", snap,
      "--out", out,
      "--mode", mode,
    ]);
  }
  return out;
};

describe("mem::graph-rows-load", () => {
  it("loads the emitter's streams into every scope the swap has to restore", async () => {
    const out = emit();

    const result = (await sdk.trigger("mem::graph-rows-load", {
      dir: out,
    })) as { success: boolean; nodes: number; edges: number };

    expect(result.success).toBe(true);
    expect(result.nodes).toBe(2);
    expect(result.edges).toBe(1);

    // Rows, and only the reachable ones: the orphan never left the emitter.
    const nodeScope = kv.store.get(KV.graphNodes)!;
    expect([...nodeScope.keys()].sort()).toEqual(["gn_a", "gn_b"]);
    const alpha = nodeScope.get("gn_a") as GraphNode;
    expect(alpha.sourceObservationIds).toEqual([]);
    expect(alpha.sourceBatchIds).toHaveLength(1);

    // The batch the rows point at travels with them, or every row resolves to
    // no observations.
    const batchId = alpha.sourceBatchIds![0]!;
    expect(kv.store.get(KV.graphBatches)!.has(batchId)).toBe(true);

    // U3's indexes, so the search path and cascade can see the rewritten corpus
    // without a second pass.
    expect(kv.store.get(KV.graphNames)!.get("gn_a")).toEqual({
      id: "gn_a",
      type: "concept",
      name: "Alpha",
    });
    expect(await readAdj(kv as never, "gn_a")).toEqual([
      { edgeId: "ge_1", neighborId: "gn_b", weight: 1 },
    ]);
    expect((await readObsIndex(kv as never, "o1")).nodes.sort()).toEqual([
      "gn_a",
      "gn_b",
    ]);
  });

  it("recomputes name-index, edge-key, and node-degree from the kept rows", async () => {
    // Derived, not carried. Without them a post-swap extract's name-index
    // lookup misses and it writes a duplicate row for every entity the rewrite
    // just kept, which is the failure the swap exists to avoid.
    const out = emit();

    await sdk.trigger("mem::graph-rows-load", { dir: out });

    expect(kv.store.get(KV.graphNameIndex)!.get("concept|Alpha")).toBe("gn_a");
    expect(kv.store.get(KV.graphNameIndex)!.has("concept|Gone")).toBe(false);
    expect(kv.store.get(KV.graphEdgeKey)!.get("gn_a|gn_b|related_to")).toBe(
      "ge_1",
    );
    expect(kv.store.get(KV.graphNodeDegree)!.get("gn_a")).toBe(1);
    expect(kv.store.get(KV.graphNodeDegree)!.get("gn_b")).toBe(1);
  });

  it("reports the failure instead of half-loading when the input is missing", async () => {
    const result = (await sdk.trigger("mem::graph-rows-load", {
      dir: join(dir, "nope"),
    })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(kv.store.get(KV.graphNodes)).toBeUndefined();
  });

  it("refuses a directory that has the nodes stream but not the edges stream", async () => {
    // The case a fallback to [] would have made silent: 37,039 nodes loaded,
    // no edges, every node-degree recomputed to zero, success reported. This
    // runs after the entrypoint retired the originals, so there is nothing left
    // on disk to retry from.
    const out = emit();
    rmSync(join(out, "edges.rows.json"));

    const result = (await sdk.trigger("mem::graph-rows-load", {
      dir: out,
    })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(kv.store.get(KV.graphNodes)).toBeUndefined();
    // A snapshot naming counts no row on disk backs is worse than no snapshot:
    // checkGraphEnumerable would size the scopes from a corpus that never
    // loaded. It is written last so a refusal leaves the scope absent.
    expect(kv.store.get(KV.graphSnapshot)).toBeUndefined();
  });

  it("writes the snapshot from the loaded rows, dropping a resolved resetAt", async () => {
    // The entrypoint retires mem:graph:snapshot with the other five scopes and
    // the loader never put it back, so readSnapshot returned null and
    // checkGraphEnumerable read totalNodes as null. It then refused before the
    // byte check for a missing measurement rather than on the corpus size,
    // which is the fail-closed P1 recorded (prototype doc :89).
    const out = emit();

    await sdk.trigger("mem::graph-rows-load", { dir: out });

    const snap = kv.store.get(KV.graphSnapshot)!.get("current") as GraphSnapshot;
    expect(snap.version).toBe(1);
    expect(snap.stats.totalNodes).toBe(2);
    expect(snap.stats.totalEdges).toBe(1);
    // The guard sizes each scope as total * measured-per-row. Both must be
    // present, or estimateScopeBytes falls back to the pre-rewrite calibrated
    // floor and reads the bounded scopes as the ones the rewrite replaced.
    expect(snap.stats.nodeRowBytes).toBeGreaterThan(0);
    expect(snap.stats.edgeRowBytes).toBeGreaterThan(0);
    // gn_orphan is pre-reset and drop mode discarded it, so the orphan
    // condition the input snapshot recorded is resolved. Carrying resetAt
    // through would keep hasOrphanRows() true and hold the guard shut for a
    // reason that no longer exists. True in drop mode only, hence the pin.
    expect(snap.resetAt).toBeUndefined();
  });

  it("carries resetAt through a keep-mode load", async () => {
    // KTD-R8. The premise above -- "the emitter dropped every pre-resetAt row"
    // -- is false in keep mode, which emits them all. Dropping the stamp there
    // would widen the writer's merge target from the 1,642 post-reset rows to
    // all 151,374 and let it regrow the provenance this rollout just capped,
    // breaking R7 silently on the boot path.
    const out = emit("keep");

    await sdk.trigger("mem::graph-rows-load", { dir: out });

    const snap = kv.store.get(KV.graphSnapshot)!.get("current") as GraphSnapshot;
    // Keep mode emitted gn_orphan and gn_twin too, so the corpus is the whole
    // fixture.
    expect(snap.stats.totalNodes).toBe(4);
    expect(snap.resetAt).toBe(RESET_AT);
  });

  it("points the rebuilt name-index at the post-reset twin in keep mode", async () => {
    // R7. The rebuild is last-write-wins in .bin order, and keep mode emits
    // both twins. If the pre-reset id wins, the writer's next touch of Alpha
    // hits it, nulls it (graph.ts:1149-1156), and creates a THIRD row, so the
    // post-reset row stops being the merge target the plan says it is. A
    // pre-reset row gets no index entry at all: the writer treats a pre-reset
    // hit and a miss identically, minus one kv.get.
    const out = emit("keep");

    await sdk.trigger("mem::graph-rows-load", { dir: out });

    const index = kv.store.get(KV.graphNameIndex)!;
    expect(index.get("concept|Alpha")).toBe("gn_a");
    expect(index.has("concept|Gone")).toBe(false);
    // Degrees are unaffected: every edge still counts, whichever side it is on.
    expect(kv.store.get(KV.graphNodeDegree)!.get("gn_a")).toBe(1);
  });

  it("refuses an emit whose two scopes name different modes", async () => {
    // The missing-stream refusal above exists because nodes without edges is
    // a store with every degree at zero. Keep nodes over drop edges is the
    // same store: 151,374 nodes against post-reset edges only. A silent
    // accept is one forgotten --mode flag away, since keep is the default and
    // U2 runs the tool once per scope.
    const out = emit("keep");
    const path = join(out, "edges.summary.json");
    const summary = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...summary, mode: "drop" }));

    const result = (await sdk.trigger("mem::graph-rows-load", {
      dir: out,
    })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(kv.store.get(KV.graphNodes)).toBeUndefined();
  });

  it("refuses a keep-mode summary whose resetAt is not a parseable stamp", async () => {
    // hasOrphanRows (graph.ts:303) and the writer's narrowing (graph.ts:1151)
    // both need a stamp that parses. An empty string is a string, passes a
    // typeof check, and turns both off: the exact R7 break the guard is for,
    // reached through the guard.
    const out = emit("keep");
    const path = join(out, "nodes.summary.json");
    const summary = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...summary, resetAt: "" }));

    const result = (await sdk.trigger("mem::graph-rows-load", {
      dir: out,
    })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(kv.store.get(KV.graphSnapshot)).toBeUndefined();
  });

  it("refuses a directory whose summary names no mode, rather than assuming drop", async () => {
    // The failure direction matters more than the check. Defaulting a missing
    // signal to drop-mode behaviour IS the R7 break above, silently, on a boot
    // nobody is watching. Same refusal class as a missing row stream: a
    // directory that cannot say which mode produced it is a wrong directory.
    const out = emit("keep");
    rmSync(join(out, "nodes.summary.json"));

    const result = (await sdk.trigger("mem::graph-rows-load", {
      dir: out,
    })) as { success: boolean };

    expect(result.success).toBe(false);
    // Refused before writing anything, so there is no half-loaded store and
    // no snapshot overstating a corpus that never landed.
    expect(kv.store.get(KV.graphNodes)).toBeUndefined();
    expect(kv.store.get(KV.graphSnapshot)).toBeUndefined();
  });
});

describe("the boot swap flag", () => {
  const read = (t: string) =>
    readFileSync(
      new URL(`../deploy/${t}/entrypoint.sh`, import.meta.url).pathname,
      "utf8",
    );

  // The ordering the whole step rests on: the originals go before the engine
  // starts, the rewritten rows go in after it is up. The shell half is what
  // makes the first true, so it has to run before the engine is exec'd.
  it("retires the six graph scopes before the engine starts, on all four targets", () => {
    for (const t of ["railway", "fly", "render", "coolify"]) {
      const body = read(t);
      const guard = body.indexOf('GRAPH_ROWS_REWRITE_AT_BOOT');
      expect(guard).toBeGreaterThan(-1);
      for (const scope of [
        "mem:graph:nodes",
        "mem:graph:edges",
        "mem:graph:snapshot",
        "mem:graph:name-index",
        "mem:graph:edge-key",
        "mem:graph:node-degree",
      ]) {
        expect(body.slice(guard)).toContain(scope);
      }
      // Before the exec that starts the engine, or the engine has already
      // loaded the gigabyte the retirement is meant to keep out.
      expect(body.lastIndexOf("exec ")).toBeGreaterThan(guard);
    }
  });

  it("surfaces a failed load trigger through bootWarn, not bootLog", () => {
    // bootLog writes nothing unless boot-verbose is on; it buffers in memory
    // (logger.ts:98-108). bootWarn always writes to stderr, and its own comment
    // says warnings must surface "even when the rest of the boot log is
    // suppressed" (logger.ts:110-116).
    //
    // The entrypoint has already retired the six graph scopes by the time this
    // trigger runs, so a failure here leaves the store with no graph at all. On
    // bootLog that is silent, which is how a sandbox boot on 2026-09-07 produced
    // neither a load line nor a failure line and looked identical to a swap that
    // never armed.
    const src = readFileSync(
      new URL("../src/index.ts", import.meta.url).pathname,
      "utf8",
    );
    const at = src.indexOf("Graph rows rewrite failed to start");
    expect(at).toBeGreaterThan(-1);
    // The call wrapping that message, read backwards from it.
    const call = src.slice(Math.max(0, at - 200), at);
    expect(call).toContain("bootWarn(");
    expect(call).not.toContain("bootLog(");
  });
});
