import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerAutoForgetFunction } from "../src/functions/auto-forget.js";
import { getSearchIndex, setVectorIndex } from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import {
  getObsRetentionDays,
  getObsRetentionMaxImportance,
  getObsRetentionMaxPerRun,
} from "../src/config.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";
import { currentAuditScope, mockKV, mockSdk } from "./helpers/mocks.js";

// The low-value pass in mem::auto-forget: eligibility needs the whole session
// idle as well as the row old, thresholds come from env with the old hardcoded
// values as defaults, a per-run cap bounds each run, and each run writes one
// audit row per operation and resource instead of one per item.

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

function memory(id: string, fields: Partial<Memory> = {}): Memory {
  return {
    id,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    type: "pattern",
    title: id,
    content: "Use React hooks for state management in all components",
    concepts: ["react"],
    files: [],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    ...fields,
  };
}

const ENV_KEYS = [
  "AGENTMEMORY_OBS_RETENTION_DAYS",
  "AGENTMEMORY_OBS_RETENTION_MAX_IMPORTANCE",
  "AGENTMEMORY_OBS_RETENTION_MAX_PER_RUN",
] as const;
const ORIG: Record<string, string | undefined> = {};

let sdk: ReturnType<typeof mockSdk>;
let kv: ReturnType<typeof mockKV>;

type AuditRow = {
  operation: string;
  targetIds: string[];
  details: Record<string, unknown> & { resource: string; byReason: Record<string, number> };
};
const audits = () => kv.list<AuditRow>(currentAuditScope());

async function seed(s: Session, rows: CompressedObservation[]) {
  await kv.set("mem:sessions", s.id, s);
  for (const r of rows) {
    await kv.set(`mem:obs:${s.id}`, r.id, r);
    getSearchIndex().add(r);
  }
}

const run = async (dryRun = false) =>
  (await sdk.trigger("mem::auto-forget", { dryRun })) as {
    ttlExpired: string[];
    contradictions: unknown[];
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

describe("observation retention defaults", () => {
  it("deletes what the old 180-day / importance-2 rule deleted, except in sessions that are not idle", async () => {
    await seed(session("idle", { updatedAt: daysAgo(200) }), [
      obs("old_low", "idle", 200, 2),
      obs("old_mid", "idle", 200, 3),
      obs("young_low", "idle", 100, 1),
      obs("old_unscored", "idle", 200, undefined),
    ]);
    // The old rule deleted this row too; the idle gate keeps it.
    await seed(session("live", { updatedAt: daysAgo(2) }), [obs("live_old_low", "live", 200, 1)]);

    const result = await run();

    expect(result.lowValueObs).toEqual(["old_low"]);
    expect(await kv.get("mem:obs:idle", "old_low")).toBeNull();
    for (const [s, id] of [
      ["idle", "old_mid"],
      ["idle", "young_low"],
      ["idle", "old_unscored"],
      ["live", "live_old_low"],
    ]) {
      expect(await kv.get(`mem:obs:${s}`, id)).not.toBeNull();
    }
  });
});

describe("observation retention under env thresholds", () => {
  beforeEach(() => {
    process.env["AGENTMEMORY_OBS_RETENTION_DAYS"] = "30";
  });

  it("deletes low-importance rows in an idle session and writes one audit row", async () => {
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
    expect(getSearchIndex().has("a")).toBe(false);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetIds.sort()).toEqual(["a", "b", "c"]);
    expect(rows[0]!.details).toMatchObject({
      resource: "observation",
      evicted: 3,
      remaining: 0,
      retentionDays: 30,
      maxImportance: 2,
      byReason: { "auto-forget low-value observation": 3 },
    });
  });

  it("leaves a session marked completed but touched 2 days ago alone", async () => {
    // `completed` flips on every turn; status is not idleness.
    await seed(session("s", { status: "completed", updatedAt: daysAgo(2) }), [obs("a", "s", 40, 1)]);

    expect((await run()).lowValueObs).toEqual([]);
    expect(await kv.get("mem:obs:s", "a")).not.toBeNull();
  });

  it("uses the most recent of updatedAt and endedAt", async () => {
    await seed(session("s", { endedAt: daysAgo(60), updatedAt: daysAgo(5) }), [obs("a", "s", 60, 1)]);

    expect((await run()).lowValueObs).toEqual([]);
  });

  it("falls back to startedAt for a session with neither stamp", async () => {
    await seed(session("s", { startedAt: daysAgo(400) }), [obs("a", "s", 40, 1)]);

    expect((await run()).lowValueObs).toEqual(["a"]);
  });

  it("keeps rows with no importance field even when the threshold would cover the old default of 5", async () => {
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_IMPORTANCE"] = "5";
    await seed(session("s", { updatedAt: daysAgo(40) }), [
      obs("scored", "s", 40, 5),
      obs("unscored", "s", 40, undefined),
    ]);

    expect((await run()).lowValueObs).toEqual(["scored"]);
    expect(await kv.get("mem:obs:s", "unscored")).not.toBeNull();
  });

  it("stops at the per-run cap and reports the remainder", async () => {
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_PER_RUN"] = "2";
    await seed(session("s", { updatedAt: daysAgo(40) }), [
      obs("a", "s", 40, 1),
      obs("b", "s", 40, 1),
      obs("c", "s", 40, 1),
      obs("d", "s", 40, 1),
      obs("e", "s", 40, 1),
    ]);

    const result = await run();

    expect(result.lowValueObs).toHaveLength(2);
    expect(result.lowValueRemaining).toBe(3);
    expect(await kv.list("mem:obs:s")).toHaveLength(3);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ evicted: 2, remaining: 3 });
  });

  it("a cap of 0 deletes nothing and is the rollback", async () => {
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_PER_RUN"] = "0";
    await seed(session("s", { updatedAt: daysAgo(40) }), [obs("a", "s", 40, 1)]);

    const result = await run();

    expect(result.lowValueObs).toEqual([]);
    expect(result.lowValueRemaining).toBe(1);
    expect(await kv.get("mem:obs:s", "a")).not.toBeNull();
    expect(await audits()).toEqual([]);
  });

  it("a delete that throws leaves the row and its index entry, and the audit row names only what was deleted", async () => {
    await seed(session("s", { updatedAt: daysAgo(40) }), [obs("bad", "s", 40, 1), obs("ok", "s", 40, 1)]);
    const realDelete = kv.delete;
    kv.delete = async (scope, key) => {
      if (key === "bad") throw new Error("engine timeout");
      return realDelete(scope, key);
    };

    const result = await run();

    expect(result.lowValueObs.sort()).toEqual(["bad", "ok"]);
    expect(await kv.get("mem:obs:s", "bad")).not.toBeNull();
    expect(getSearchIndex().has("bad")).toBe(true);
    expect(await kv.get("mem:obs:s", "ok")).toBeNull();
    expect((await audits())[0]!.targetIds).toEqual(["ok"]);
  });

  it("dry run reports counts and deletes nothing from store, index, or audit log", async () => {
    await seed(session("s", { updatedAt: daysAgo(40) }), [obs("stale", "s", 40, 1)]);

    const result = await run(true);

    expect(result.lowValueObs).toEqual(["stale"]);
    expect(await kv.get("mem:obs:s", "stale")).not.toBeNull();
    expect(getSearchIndex().has("stale")).toBe(true);
    expect(await audits()).toEqual([]);
  });
});

describe("auto-forget audit rows", () => {
  it("one run that deletes for TTL, demotes a contradiction, and deletes low-value rows writes one row per operation and resource", async () => {
    await kv.set("mem:memories", "ttl_1", memory("ttl_1", { forgetAfter: "2020-01-01T00:00:00Z", concepts: [] }));
    await kv.set("mem:memories", "ttl_2", memory("ttl_2", { forgetAfter: "2020-01-01T00:00:00Z", concepts: [] }));
    await kv.set("mem:memories", "dup_old", memory("dup_old", { createdAt: "2026-01-01T00:00:00Z" }));
    await kv.set("mem:memories", "dup_new", memory("dup_new", { createdAt: "2026-02-01T00:00:00Z" }));
    await seed(session("s", { updatedAt: daysAgo(200) }), [obs("o1", "s", 200, 1), obs("o2", "s", 200, 2)]);

    const result = await run();

    expect(result.ttlExpired.sort()).toEqual(["ttl_1", "ttl_2"]);
    expect(result.contradictions).toHaveLength(1);
    expect(result.lowValueObs.sort()).toEqual(["o1", "o2"]);
    const rows = await audits();
    expect(rows).toHaveLength(3);
    const ttl = rows.find((r) => r.details.reason === "auto-forget TTL")!;
    expect(ttl.operation).toBe("delete");
    expect(ttl.targetIds.sort()).toEqual(["ttl_1", "ttl_2"]);
    expect(ttl.details).toMatchObject({ resource: "memory", byReason: { "auto-forget TTL": 2 } });
    const demoted = rows.find((r) => r.details.reason === "auto-forget contradiction")!;
    expect(demoted.operation).toBe("forget");
    expect(demoted.targetIds).toEqual(["dup_old"]);
    expect(demoted.details).toMatchObject({
      resource: "memory",
      byReason: { "auto-forget contradiction": 1 },
    });
    const low = rows.find((r) => r.details.reason === "auto-forget low-value observation")!;
    expect(low.operation).toBe("delete");
    expect(low.targetIds.sort()).toEqual(["o1", "o2"]);
    expect(low.details).toMatchObject({
      resource: "observation",
      byReason: { "auto-forget low-value observation": 2 },
    });
  });

  it("records the TTL deletes that landed before a delete throws", async () => {
    await kv.set("mem:memories", "ttl_ok", memory("ttl_ok", { forgetAfter: "2020-01-01T00:00:00Z" }));
    await kv.set("mem:memories", "ttl_bad", memory("ttl_bad", { forgetAfter: "2020-01-01T00:00:00Z" }));
    const realDelete = kv.delete;
    kv.delete = async (scope, key) => {
      if (key === "ttl_bad") throw new Error("engine timeout");
      return realDelete(scope, key);
    };

    await expect(run()).rejects.toThrow("engine timeout");

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetIds).toEqual(["ttl_ok"]);
  });
});

describe("observation retention env parsing", () => {
  it("reads each variable from env", () => {
    process.env["AGENTMEMORY_OBS_RETENTION_DAYS"] = "7";
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_IMPORTANCE"] = "4";
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_PER_RUN"] = "2000";
    expect(getObsRetentionDays()).toBe(7);
    expect(getObsRetentionMaxImportance()).toBe(4);
    expect(getObsRetentionMaxPerRun()).toBe(2000);
  });

  it("defaults to 180 days, importance 2, and 500 per run", () => {
    expect(getObsRetentionDays()).toBe(180);
    expect(getObsRetentionMaxImportance()).toBe(2);
    expect(getObsRetentionMaxPerRun()).toBe(500);
  });

  it.each(["abc", "0", "-3"])("falls back to 180 days for %s", (value) => {
    process.env["AGENTMEMORY_OBS_RETENTION_DAYS"] = value;
    expect(getObsRetentionDays()).toBe(180);
  });

  it.each(["abc", "-1"])("falls back to importance 2 for %s", (value) => {
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_IMPORTANCE"] = value;
    expect(getObsRetentionMaxImportance()).toBe(2);
  });

  it.each(["abc", "-1"])("falls back to 500 per run for %s", (value) => {
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_PER_RUN"] = value;
    expect(getObsRetentionMaxPerRun()).toBe(500);
  });

  it("accepts 0 per run and 0 importance", () => {
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_PER_RUN"] = "0";
    process.env["AGENTMEMORY_OBS_RETENTION_MAX_IMPORTANCE"] = "0";
    expect(getObsRetentionMaxPerRun()).toBe(0);
    expect(getObsRetentionMaxImportance()).toBe(0);
  });
});
