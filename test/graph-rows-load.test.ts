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
import type { GraphNode } from "../src/types.js";
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

const emit = () => {
  const snap = writeBin("snap.bin", {
    current: { version: 1, resetAt: RESET_AT },
  });
  const nodes = writeBin("nodes.bin", {
    gn_a: node("gn_a", "Alpha", "2026-09-03T00:00:00Z", ["o1"]),
    gn_b: node("gn_b", "Beta", "2026-09-03T00:00:00Z", ["o1"]),
    gn_orphan: node("gn_orphan", "Gone", "2026-09-01T00:00:00Z", ["o9"]),
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
});
