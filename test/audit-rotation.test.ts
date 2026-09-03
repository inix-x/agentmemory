import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  recordAudit,
  queryAudit,
  auditQueryScopes,
  rotateAuditPartitions,
} from "../src/functions/audit.js";
import { KV } from "../src/state/schema.js";
import { isOversized } from "../src/state/scope-size.js";
import { SAFE_ENUMERATION_BYTES } from "../src/state/scope-size.js";
import type { AuditEntry } from "../src/types.js";

// U6 of the memory-reduction ladder. The audit scope grew without bound and is
// over the enumeration guard in production, so every /agentmemory/audit is a
// 413 and nothing in-process can rotate it. Rows now land in one scope per UTC
// month, queries read this month and last, and rotation deletes whole
// partitions older than the retention window.

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

const month = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 15));

function seedRow(
  kv: ReturnType<typeof mockKV>,
  at: Date,
  id: string,
  operation: AuditEntry["operation"] = "observe",
) {
  const scope = KV.auditMonth(at);
  if (!kv.store.has(scope)) kv.store.set(scope, new Map());
  kv.store.get(scope)!.set(id, {
    id,
    timestamp: at.toISOString(),
    operation,
    functionId: "test",
    targetIds: [],
    details: {},
  } satisfies AuditEntry);
}

let kv: ReturnType<typeof mockKV>;

beforeEach(() => {
  kv = mockKV();
  vi.useFakeTimers();
  vi.setSystemTime(month(2026, 9));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("audit partitioning", () => {
  it("writes a new row into this month's partition, not the legacy scope", async () => {
    await recordAudit(kv as never, "observe", "mem::test", ["x"]);

    expect(kv.store.has("mem:audit:2026-09")).toBe(true);
    expect(kv.store.get("mem:audit:2026-09")!.size).toBe(1);
    // The legacy scope is the one file production cannot read; nothing may
    // write to it again.
    expect(kv.store.has(KV.audit)).toBe(false);
  });

  it("names partitions by UTC month with a zero-padded month", () => {
    expect(KV.auditMonth(month(2026, 1))).toBe("mem:audit:2026-01");
    expect(KV.auditMonth(month(2026, 12))).toBe("mem:audit:2026-12");
    // Day 31 at 23:59 UTC is still that month, not the next one in a
    // positive-offset local zone.
    expect(KV.auditMonth(new Date(Date.UTC(2026, 0, 31, 23, 59)))).toBe(
      "mem:audit:2026-01",
    );
  });

  it("queries read this month and last, and not two months back", async () => {
    seedRow(kv, month(2026, 9), "this");
    seedRow(kv, month(2026, 8), "last");
    seedRow(kv, month(2026, 7), "old");

    const rows = await queryAudit(kv as never);

    expect(isOversized(rows)).toBe(false);
    expect((rows as AuditEntry[]).map((r) => r.id)).toEqual(["this", "last"]);
  });

  it("query scopes roll over a year boundary", () => {
    expect(auditQueryScopes(month(2027, 1))).toEqual([
      "mem:audit:2027-01",
      "mem:audit:2026-12",
    ]);
  });

  it("queries keep the newest-first order across both partitions", async () => {
    seedRow(kv, new Date(Date.UTC(2026, 7, 30)), "aug30");
    seedRow(kv, new Date(Date.UTC(2026, 8, 2)), "sep02");
    seedRow(kv, new Date(Date.UTC(2026, 8, 1)), "sep01");

    const rows = (await queryAudit(kv as never)) as AuditEntry[];

    expect(rows.map((r) => r.id)).toEqual(["sep02", "sep01", "aug30"]);
  });

  it("hands back the oversize refusal when a single partition trips the guard", async () => {
    // Record a size over the guard for this month's partition, the way
    // listBounded would have learned it from a prior read.
    await kv.set(KV.scopeSize, "mem:audit:2026-09", {
      bytes: SAFE_ENUMERATION_BYTES + 1,
      at: new Date().toISOString(),
    });
    seedRow(kv, month(2026, 9), "x");

    const rows = await queryAudit(kv as never);

    expect(isOversized(rows)).toBe(true);
  });
});

describe("audit rotation", () => {
  it("empties partitions older than retention and keeps the rest", async () => {
    seedRow(kv, month(2026, 9), "m0");
    seedRow(kv, month(2026, 8), "m1");
    seedRow(kv, month(2026, 7), "m2");
    seedRow(kv, month(2026, 6), "m3");
    seedRow(kv, month(2026, 5), "m4a");
    seedRow(kv, month(2026, 5), "m4b");

    const result = await rotateAuditPartitions(kv as never, month(2026, 9), 3);

    // Retention 3 keeps Sep, Aug, Jul. Jun and May go.
    expect(result).toEqual({ partitionsEmptied: 2, rowsDeleted: 3 });
    expect(kv.store.get("mem:audit:2026-09")!.size).toBe(1);
    expect(kv.store.get("mem:audit:2026-08")!.size).toBe(1);
    expect(kv.store.get("mem:audit:2026-07")!.size).toBe(1);
    expect(kv.store.get("mem:audit:2026-06")!.size).toBe(0);
    expect(kv.store.get("mem:audit:2026-05")!.size).toBe(0);
  });

  it("with retention 1, empties a partition two months old and keeps one month old", async () => {
    seedRow(kv, month(2026, 9), "cur");
    seedRow(kv, month(2026, 8), "one");
    seedRow(kv, month(2026, 7), "two");

    await rotateAuditPartitions(kv as never, month(2026, 9), 1);

    expect(kv.store.get("mem:audit:2026-09")!.size).toBe(1);
    // Retention 1 keeps only the current month; last month is the first
    // deleted. This is the tightest setting and the one that reads the
    // partition a query is still reading, which is why the default is 3.
    expect(kv.store.get("mem:audit:2026-08")!.size).toBe(0);
    expect(kv.store.get("mem:audit:2026-07")!.size).toBe(0);
  });

  it("never touches the legacy scope", async () => {
    kv.store.set(KV.audit, new Map([["legacy", { id: "legacy" }]]));
    seedRow(kv, month(2025, 1), "ancient");

    await rotateAuditPartitions(kv as never, month(2026, 9), 3);

    expect(kv.store.get(KV.audit)!.size).toBe(1);
  });

  it("does nothing and reports zeros when every partition is inside retention", async () => {
    seedRow(kv, month(2026, 9), "a");
    seedRow(kv, month(2026, 8), "b");

    expect(await rotateAuditPartitions(kv as never, month(2026, 9), 3)).toEqual({
      partitionsEmptied: 0,
      rowsDeleted: 0,
    });
  });

  it("continues past a row whose delete throws", async () => {
    seedRow(kv, month(2026, 5), "ok1");
    seedRow(kv, month(2026, 5), "bad");
    seedRow(kv, month(2026, 5), "ok2");
    const realDelete = kv.delete;
    kv.delete = async (scope, key) => {
      if (key === "bad") throw new Error("engine timeout");
      return realDelete(scope, key);
    };

    const result = await rotateAuditPartitions(kv as never, month(2026, 9), 3);

    expect(result.rowsDeleted).toBe(2);
    expect(kv.store.get("mem:audit:2026-05")!.has("bad")).toBe(true);
  });
});
