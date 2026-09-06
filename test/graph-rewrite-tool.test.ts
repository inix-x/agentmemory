import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// U2's offline emitter. KTD3: parse offline, let the engine write. Python
// because the real inputs are 1 GB scope files walked byte by byte, which is
// the read a whole-file JSON.parse cannot do at that size, and because it is
// the same parser the plan's appendix specifies for the census.
//
// The .bin fixtures are built the way the engine writes one: the scope's JSON
// object from offset 0, then a short trailer, so the body is
// data[0 : data.rfind("}") + 1].

const TOOL = new URL("../scripts/graph-rewrite/rewrite.py", import.meta.url)
  .pathname;

const RESET_AT = "2026-09-02T19:50:03.637Z";

const node = (id: string, createdAt: string, obsIds: string[]) => ({
  id,
  type: "concept",
  name: `n-${id}`,
  properties: {},
  sourceObservationIds: obsIds,
  createdAt,
});

let dir: string;

const writeBin = (name: string, scopeMap: Record<string, unknown>) => {
  const path = join(dir, name);
  // JSON body, then a trailer the parser must ignore by finding the last "}".
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(JSON.stringify(scopeMap), "utf8"),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    ]),
  );
  return path;
};

const run = (args: string[]) =>
  JSON.parse(
    execFileSync("python3", [TOOL, ...args], { encoding: "utf8" }).trim(),
  ) as Record<string, number | string | boolean>;

const readOut = <T>(name: string): T =>
  JSON.parse(readFileSync(join(dir, "out", name), "utf8")) as T;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "u2-rewrite-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the graph rewrite emitter", () => {
  const snapshot = () =>
    writeBin("snap.bin", { current: { version: 1, resetAt: RESET_AT } });

  it("keeps every reachable row and drops every orphan", () => {
    // mem::graph-reset leaves every row on disk and stamps resetAt; extract
    // then treats anything older as an orphan. Production's split is 112,428
    // orphan nodes against 37,039 reachable.
    const bin = writeBin("nodes.bin", {
      gn_pre1: node("gn_pre1", "2026-09-01T00:00:00Z", ["o1"]),
      gn_pre2: node("gn_pre2", "2026-09-02T19:50:03.636Z", ["o2"]),
      gn_at: node("gn_at", RESET_AT, ["o3"]),
      gn_post1: node("gn_post1", "2026-09-03T00:00:00Z", ["o3", "o4"]),
      gn_post2: node("gn_post2", "2026-09-04T00:00:00Z", ["o5"]),
    });

    const summary = run([
      "--scope", "nodes",
      "--bin", bin,
      "--snapshot", snapshot(),
      "--out", join(dir, "out"),
    ]);

    // The predicate is createdAt < resetAt, so a row stamped exactly at the
    // reset is reachable. That boundary is the whole split.
    expect(summary.kept).toBe(3);
    expect(summary.dropped).toBe(2);
    expect(summary.resetAt).toBe(RESET_AT);

    const rows = readOut<Array<{ key: string }>>("nodes.rows.json");
    expect(rows.map((r) => r.key).sort()).toEqual([
      "gn_at",
      "gn_post1",
      "gn_post2",
    ]);
  });

  it("replaces observation ids with a backfill batch and emits the obs-index", () => {
    const bin = writeBin("nodes.bin", {
      gn_a: node("gn_a", "2026-09-03T00:00:00Z", ["o1", "o2"]),
      gn_b: node("gn_b", "2026-09-03T00:00:00Z", ["o2"]),
    });

    run([
      "--scope", "nodes",
      "--bin", bin,
      "--snapshot", snapshot(),
      "--out", join(dir, "out"),
    ]);

    const rows = readOut<
      Array<{
        key: string;
        value: { sourceObservationIds: string[]; sourceBatchIds: string[] };
      }>
    >("nodes.rows.json");
    const batches = readOut<Array<{ id: string; observationIds: string[] }>>(
      "nodes.batches.json",
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.observationIds).toEqual(["o1", "o2"]);
    for (const r of rows) {
      expect(r.value.sourceObservationIds).toEqual([]);
      expect(r.value.sourceBatchIds).toEqual([batches[0]!.id]);
    }

    const obsIndex = readOut<
      Array<{ key: string; value: { nodes: string[]; edges: string[] } }>
    >("nodes.obs-index.json");
    const byObs = Object.fromEntries(obsIndex.map((e) => [e.key, e.value]));
    expect(byObs["o1"]!.nodes).toEqual(["gn_a"]);
    expect(byObs["o2"]!.nodes.sort()).toEqual(["gn_a", "gn_b"]);
  });

  it("round-trips its own output through the parser with the same records", () => {
    // D4's stated mitigation. A counts-only check passes on an emitter that
    // mangles every field, so this compares the ids and the record bodies.
    const bin = writeBin("nodes.bin", {
      gn_a: node("gn_a", "2026-09-03T00:00:00Z", ["o1"]),
      gn_b: node("gn_b", "2026-09-04T00:00:00Z", ["o2"]),
      gn_c: node("gn_c", "2026-09-05T00:00:00Z", []),
    });

    run([
      "--scope", "nodes",
      "--bin", bin,
      "--snapshot", snapshot(),
      "--out", join(dir, "out"),
    ]);

    const rows = readOut<Array<{ key: string; value: Record<string, unknown> }>>(
      "nodes.rows.json",
    );
    // Feed the emitted rows back in as a scope file and parse them again.
    const reBin = writeBin(
      "round.bin",
      Object.fromEntries(rows.map((r) => [r.key, r.value])),
    );
    const summary = run([
      "--scope", "nodes",
      "--bin", reBin,
      "--snapshot", snapshot(),
      "--out", join(dir, "out2"),
    ]);
    expect(summary.kept).toBe(3);
    expect(summary.dropped).toBe(0);

    const again = JSON.parse(
      readFileSync(join(dir, "out2", "nodes.rows.json"), "utf8"),
    ) as Array<{ key: string; value: Record<string, unknown> }>;
    expect(again.map((r) => r.key)).toEqual(rows.map((r) => r.key));
    for (let i = 0; i < rows.length; i++) {
      expect(again[i]!.value["id"]).toBe(rows[i]!.value["id"]);
      expect(again[i]!.value["name"]).toBe(rows[i]!.value["name"]);
      expect(again[i]!.value["createdAt"]).toBe(rows[i]!.value["createdAt"]);
    }
    expect(reBin).toContain("round.bin");
  });

  it("refuses when resetAt changed since it was recorded", () => {
    // D2. A second reset turns every reachable row into an orphan, so a rewrite
    // computed against the old stamp would drop rows it should keep.
    const bin = writeBin("nodes.bin", {
      gn_a: node("gn_a", "2026-09-03T00:00:00Z", ["o1"]),
    });

    expect(() =>
      run([
        "--scope", "nodes",
        "--bin", bin,
        "--snapshot", snapshot(),
        "--out", join(dir, "out"),
        "--expect-reset-at", "2026-09-01T00:00:00.000Z",
      ]),
    ).toThrow(/resetAt changed/);
  });

  it("chunks the backfill batch so no batch row is unbounded", () => {
    const obsIds = Array.from({ length: 25 }, (_, i) => `o${i}`);
    const bin = writeBin("nodes.bin", {
      gn_a: node("gn_a", "2026-09-03T00:00:00Z", obsIds),
    });

    run([
      "--scope", "nodes",
      "--bin", bin,
      "--snapshot", snapshot(),
      "--out", join(dir, "out"),
      "--batch-chunk", "10",
    ]);

    const batches = readOut<Array<{ observationIds: string[] }>>(
      "nodes.batches.json",
    );
    expect(batches).toHaveLength(3);
    for (const b of batches) {
      expect(b.observationIds.length).toBeLessThanOrEqual(10);
    }
    // The row points at every chunk covering its own observations, capped the
    // same way mergeNode caps.
    const rows = readOut<Array<{ value: { sourceBatchIds: string[] } }>>(
      "nodes.rows.json",
    );
    expect(rows[0]!.value.sourceBatchIds).toHaveLength(3);
  });

  it("stops transposing at the obs-index pair ceiling", () => {
    const bin = writeBin("nodes.bin", {
      gn_a: node("gn_a", "2026-09-03T00:00:00Z", ["o1", "o2", "o3"]),
    });

    const summary = run([
      "--scope", "nodes",
      "--bin", bin,
      "--snapshot", snapshot(),
      "--out", join(dir, "out"),
      "--max-obs-pairs", "2",
    ]);

    expect(summary.pairCeilingHit).toBe(true);
    expect(summary.obsIndexPairs).toBe(2);
    // The batch stream is unaffected: it is derived from the ids, not the pairs.
    expect(summary.observationIds).toBe(3);
  });
});
