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

  // Rows either side of the stamp. Both modes read this same fixture, which is
  // what makes the two counts comparable.
  const splitBin = () =>
    writeBin("nodes.bin", {
      gn_pre1: node("gn_pre1", "2026-09-01T00:00:00Z", ["o1"]),
      gn_pre2: node("gn_pre2", "2026-09-02T19:50:03.636Z", ["o2"]),
      gn_at: node("gn_at", RESET_AT, ["o3"]),
      gn_post1: node("gn_post1", "2026-09-03T00:00:00Z", ["o3", "o4"]),
      gn_post2: node("gn_post2", "2026-09-04T00:00:00Z", ["o5"]),
    });

  it("keeps every row by default and caps provenance on all of them", () => {
    // KTD-R1. Dropping is what the tool used to do by default; on production
    // that predicate discards 149,732 of 151,374 nodes, a month of real graph.
    // Capping alone is 93% of the memory win, so keep is the default and drop
    // is the option. No --mode here on purpose: the default is the thing the
    // rollout depends on, so the default is what this pins.
    const summary = run([
      "--scope", "nodes",
      "--bin", splitBin(),
      "--snapshot", snapshot(),
      "--out", join(dir, "out"),
    ]);

    expect(summary.mode).toBe("keep");
    expect(summary.kept).toBe(5);
    expect(summary.dropped).toBe(0);
    expect(summary.resetAt).toBe(RESET_AT);

    const rows = readOut<
      Array<{
        key: string;
        value: { sourceObservationIds: string[]; sourceBatchIds: string[] };
      }>
    >("nodes.rows.json");
    expect(rows.map((r) => r.key).sort()).toEqual([
      "gn_at",
      "gn_post1",
      "gn_post2",
      "gn_pre1",
      "gn_pre2",
    ]);
    // R2. Every row, including the ones drop mode would have discarded, sheds
    // its observation ids and carries a batch reference instead.
    for (const r of rows) {
      expect(r.value.sourceObservationIds).toEqual([]);
      expect(r.value.sourceBatchIds.length).toBeGreaterThan(0);
    }
  });

  it("drops every orphan in drop mode, reproducing the pre-U1 counts", () => {
    // mem::graph-reset leaves every row on disk and stamps resetAt; extract
    // then treats anything older as an orphan. Production's split is 112,428
    // orphan nodes against 37,039 reachable. Behaviour kept reachable because
    // it is still correct after a real reset; this pins it unchanged.
    const summary = run([
      "--scope", "nodes",
      "--bin", splitBin(),
      "--snapshot", snapshot(),
      "--out", join(dir, "out"),
      "--mode", "drop",
    ]);

    // The predicate is createdAt < resetAt, so a row stamped exactly at the
    // reset is reachable. That boundary is the whole split.
    expect(summary.mode).toBe("drop");
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

  it("truncates an obs-index entry past the ceiling without emitting fewer rows", () => {
    // The Risks case, and the reason the tool's original safety argument does
    // not survive keep mode. That argument was "an id either has an entry and
    // the answer is exact, or it does not". False: the entry is created for
    // every distinct id and only the appends are gated, so past the ceiling an
    // id keeps a SHORT list no reader can tell from a complete one. Nothing
    // reads obs-index until the origin plan's U3 read path lands, which is the
    // only reason this is acceptable; a backfill is named follow-on work.
    const bin = writeBin("nodes.bin", {
      gn_pre: node("gn_pre", "2026-09-01T00:00:00Z", ["o1"]),
      gn_1: node("gn_1", "2026-09-03T00:00:00Z", ["o1"]),
      gn_2: node("gn_2", "2026-09-04T00:00:00Z", ["o1"]),
    });

    const summary = run([
      "--scope", "nodes",
      "--bin", bin,
      "--snapshot", snapshot(),
      "--out", join(dir, "out"),
      "--max-obs-pairs", "2",
    ]);

    expect(summary.pairCeilingHit).toBe(true);
    // R1 holds regardless: the ceiling bounds the transpose, never the rows.
    expect(summary.kept).toBe(3);
    expect(summary.dropped).toBe(0);

    const obsIndex = readOut<
      Array<{ key: string; value: { nodes: string[] } }>
    >("nodes.obs-index.json");
    const o1 = obsIndex.find((e) => e.key === "o1")!;
    // Two of the three rows citing o1, and no marker saying so.
    expect(o1.value.nodes).toHaveLength(2);
    expect(readOut<unknown[]>("nodes.rows.json")).toHaveLength(3);
  });
});
