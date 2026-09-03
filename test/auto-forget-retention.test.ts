import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerAutoForgetFunction } from "../src/functions/auto-forget.js";
import { getSearchIndex, setVectorIndex } from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { auditQueryScopes } from "../src/functions/audit.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

// recordAudit writes to the current monthly partition (U6, #13, now on
// production). This is the same substitution #13 made in six other test files.
const AUDIT_SCOPE = auditQueryScopes()[0]!;

// U5 of the memory-reduction ladder. The low-value pass in mem::auto-forget
// gains: eligibility by when the SESSION was last touched rather than by row age
// alone, thresholds from env with today's values as defaults, a per-run cap,
// and one audit row per run. This ships dark -- with the env unset it deletes
// exactly what today's code deletes -- and the regression case at the bottom
// pins that.

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();

function session(id: string, fields: Partial<Session> = {}): Session {
  return {
    id,
    project: "p",
    cwd: "/p",
    startedAt: daysAgo(400),
    status: "completed",
    observationCount: 0,
    ...fields,
  };
}

function obs(
  id: string,
  sessionId: string,
  ageDays: number,
  importance: number | undefined,
): CompressedObservation {
  const o: CompressedObservation = {
    id,
    sessionId,
    timestamp: daysAgo(ageDays),
    type: "other",
    title: id,
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 5,
  };
  if (importance === undefined) delete (o as { importance?: number }).importance;
  else o.importance = importance;
  return o;
}

const ENV_KEYS = [
  "OBS_RETENTION_DAYS",
  "OBS_RETENTION_MAX_IMPORTANCE",
  "OBS_RETENTION_MAX_PER_RUN",
] as const;
const ORIG: Record<string, string | undefined> = {};

let sdk: ReturnType<typeof mockSdk>;
let kv: ReturnType<typeof mockKV>;

async function seed(s: Session, rows: CompressedObservation[]) {
  await kv.set("mem:sessions", s.id, s);
  for (const r of rows) {
    await kv.set(`mem:obs:${s.id}`, r.id, r);
    getSearchIndex().add(r);
  }
}

const run = async (dryRun = false) =>
  (await sdk.trigger("mem::auto-forget", { dryRun })) as {
    lowValueObs: string[];
    lowValueRemaining: number;
  };

beforeEach(() => {
  for (const k of ENV_KEYS) {
    ORIG[k] = process.env[k];
    delete process.env[k];
  }
  sdk = mockSdk({ looseTrigger: true });
  kv = mockKV();
  getSearchIndex().clear();
  setVectorIndex(new VectorIndex());
  registerAutoForgetFunction(sdk as never, kv as never);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  setVectorIndex(null);
});

describe("observation retention under env thresholds", () => {
  it("deletes low-importance rows in an idle session and keeps the important one", async () => {
    process.env["OBS_RETENTION_DAYS"] = "30";
    await seed(session("s", { updatedAt: daysAgo(40), endedAt: daysAgo(40) }), [
      obs("a", "s", 40, 2),
      obs("b", "s", 40, 2),
      obs("c", "s", 40, 1),
      obs("keep", "s", 40, 5),
    ]);

    const result = await run();

    expect(result.lowValueObs.sort()).toEqual(["a", "b", "c"]);
    expect(await kv.get("mem:obs:s", "keep")).not.toBeNull();
    expect(await kv.get("mem:obs:s", "a")).toBeNull();
    // Index forgets them at the same time.
    expect(getSearchIndex().search("a", 5).map((r) => r.obsId)).not.toContain("a");
    // One audit row for the whole run, not one per row.
    const audits = await kv.list<{ targetIds: string[]; details: { evicted: number } }>(
      AUDIT_SCOPE,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.targetIds.sort()).toEqual(["a", "b", "c"]);
    expect(audits[0]!.details.evicted).toBe(3);
  });

  it("leaves a session marked completed but touched 2 days ago alone", async () => {
    // `completed` flips on every turn; status is not idleness.
    process.env["OBS_RETENTION_DAYS"] = "30";
    await seed(session("s", { status: "completed", updatedAt: daysAgo(2) }), [
      obs("a", "s", 40, 1),
    ]);

    expect((await run()).lowValueObs).toEqual([]);
    expect(await kv.get("mem:obs:s", "a")).not.toBeNull();
  });

  it("leaves a session idle 10 days alone at a 30-day threshold", async () => {
    process.env["OBS_RETENTION_DAYS"] = "30";
    await seed(session("s", { updatedAt: daysAgo(10) }), [obs("a", "s", 40, 1)]);

    expect((await run()).lowValueObs).toEqual([]);
  });

  it("uses the most recent of updatedAt and endedAt", async () => {
    process.env["OBS_RETENTION_DAYS"] = "30";
    // endedAt is old but updatedAt is recent: still live.
    await seed(session("s", { endedAt: daysAgo(60), updatedAt: daysAgo(5) }), [
      obs("a", "s", 60, 1),
    ]);

    expect((await run()).lowValueObs).toEqual([]);
  });

  it("falls back to startedAt for a session with neither stamp", async () => {
    // Sessions predating updatedAt/endedAt must not become immune to
    // retention by being old.
    process.env["OBS_RETENTION_DAYS"] = "30";
    await seed(session("s", { startedAt: daysAgo(400) }), [obs("a", "s", 40, 1)]);

    expect((await run()).lowValueObs).toEqual(["a"]);
  });

  it("keeps rows with no importance field", async () => {
    process.env["OBS_RETENTION_DAYS"] = "30";
    await seed(session("s", { updatedAt: daysAgo(40) }), [
      obs("scored", "s", 40, 1),
      obs("unscored", "s", 40, undefined),
    ]);

    expect((await run()).lowValueObs).toEqual(["scored"]);
    expect(await kv.get("mem:obs:s", "unscored")).not.toBeNull();
  });

  it("stops at the per-run cap and reports the remainder", async () => {
    process.env["OBS_RETENTION_DAYS"] = "30";
    process.env["OBS_RETENTION_MAX_PER_RUN"] = "2";
    await seed(session("s", { updatedAt: daysAgo(40) }), [
      obs("a", "s", 40, 1),
      obs("b", "s", 40, 1),
      obs("c", "s", 40, 1),
    ]);

    const result = await run();

    expect(result.lowValueObs).toHaveLength(2);
    expect(result.lowValueRemaining).toBe(1);
  });

  it("a cap of 0 deletes nothing and is the rollback", async () => {
    process.env["OBS_RETENTION_DAYS"] = "30";
    process.env["OBS_RETENTION_MAX_PER_RUN"] = "0";
    await seed(session("s", { updatedAt: daysAgo(40) }), [obs("a", "s", 40, 1)]);

    const result = await run();

    expect(result.lowValueObs).toEqual([]);
    expect(result.lowValueRemaining).toBe(1);
    expect(await kv.get("mem:obs:s", "a")).not.toBeNull();
  });

  it("a kv.delete that throws leaves the row in the index and continues", async () => {
    process.env["OBS_RETENTION_DAYS"] = "30";
    await seed(session("s", { updatedAt: daysAgo(40) }), [
      obs("bad", "s", 40, 1),
      obs("ok", "s", 40, 1),
    ]);
    const realDelete = kv.delete;
    kv.delete = async (scope, key) => {
      if (key === "bad") throw new Error("engine timeout");
      return realDelete(scope, key);
    };

    const result = await run();

    expect(result.lowValueObs.sort()).toEqual(["bad", "ok"]);
    // The failed one is still in the store and still in the index -- an
    // index entry with no row would be the ghost hit the search probe logs.
    expect(await kv.get("mem:obs:s", "bad")).not.toBeNull();
    expect(getSearchIndex().search("bad", 5).map((r) => r.obsId)).toContain("bad");
    expect(await kv.get("mem:obs:s", "ok")).toBeNull();
    // The audit row names only what was actually deleted.
    const audits = await kv.list<{ targetIds: string[] }>(AUDIT_SCOPE);
    expect(audits[0]!.targetIds).toEqual(["ok"]);
  });

  it("dry run reports counts and deletes nothing from store or index", async () => {
    process.env["OBS_RETENTION_DAYS"] = "30";
    // A tokenizable id: single letters are dropped by the tokenizer, so a
    // search for "a" returns nothing whether or not "a" is indexed, and the
    // assertion below would pass vacuously.
    await seed(session("s", { updatedAt: daysAgo(40) }), [obs("stale", "s", 40, 1)]);

    const result = await run(true);

    expect(result.lowValueObs).toEqual(["stale"]);
    expect(await kv.get("mem:obs:s", "stale")).not.toBeNull();
    expect(getSearchIndex().search("stale", 5).map((r) => r.obsId)).toContain("stale");
    expect(await kv.list(AUDIT_SCOPE)).toEqual([]);
  });

  it("regression: with the env unset, a 100-day-old importance-2 row is kept exactly as today", async () => {
    // Defaults are 180 days / importance 2. This is the "ships dark" contract.
    await seed(session("s", { updatedAt: daysAgo(100) }), [obs("a", "s", 100, 2)]);

    expect((await run()).lowValueObs).toEqual([]);
  });

  it("regression: with the env unset, a 200-day-old importance-2 row is deleted exactly as today", async () => {
    await seed(session("s", { updatedAt: daysAgo(200) }), [obs("a", "s", 200, 2)]);

    expect((await run()).lowValueObs).toEqual(["a"]);
  });
});
