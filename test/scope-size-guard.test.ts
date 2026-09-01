import { describe, it, expect } from "vitest";
import { KV } from "../src/state/schema.js";
import {
  listBounded,
  isOversized,
  readScopeSize,
  SAFE_ENUMERATION_BYTES,
} from "../src/state/scope-size.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listCalls: string[] = [];
  return {
    store,
    listCalls,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function seedRows(kv: ReturnType<typeof mockKV>, scope: string, n: number, pad = 8) {
  if (!kv.store.has(scope)) kv.store.set(scope, new Map());
  const m = kv.store.get(scope)!;
  for (let i = 0; i < n; i++) m.set(`k${i}`, { id: `k${i}`, blob: "x".repeat(pad) });
}

const HINT = "use ?limit to page";

describe("scope-size guard (#814 pattern, non-graph scopes)", () => {
  it("refuses a scope whose recorded size is over the ceiling, WITHOUT reading it", async () => {
    const kv = mockKV();
    await kv.set(KV.scopeSize, KV.semantic, {
      rows: 9000,
      bytes: SAFE_ENUMERATION_BYTES + 1,
      measuredAt: "2026-09-01T00:00:00Z",
    });
    seedRows(kv, KV.semantic, 5);

    const result = await listBounded(kv as never, KV.semantic, HINT);

    expect(isOversized(result)).toBe(true);
    // The whole point: the expensive read never happened.
    expect(kv.listCalls).not.toContain(KV.semantic);
    if (isOversized(result)) {
      expect(result.error).toContain(HINT);
      expect(result.oversized).toBe(true);
    }
  });

  it("seeds known-oversized scopes so the first read is guarded too", async () => {
    const kv = mockKV();
    // Nothing recorded — KV.memories is seeded at 38.5 MB from production.
    const known = await readScopeSize(kv as never, KV.memories);
    expect(known?.bytes).toBeGreaterThan(SAFE_ENUMERATION_BYTES);

    const result = await listBounded(kv as never, KV.memories, HINT);
    expect(isOversized(result)).toBe(true);
    expect(kv.listCalls).not.toContain(KV.memories);
  });

  it("passes a small scope through and records what it cost", async () => {
    const kv = mockKV();
    seedRows(kv, KV.lessons, 4);

    const result = await listBounded(kv as never, KV.lessons, HINT);

    expect(isOversized(result)).toBe(false);
    expect(Array.isArray(result) && result.length).toBe(4);
    expect(kv.listCalls).toContain(KV.lessons);

    const recorded = await readScopeSize(kv as never, KV.lessons);
    expect(recorded).toBeTruthy();
    expect(recorded!.rows).toBe(4);
    expect(recorded!.bytes).toBeGreaterThan(0);
  });

  it("uses the recorded size on the next call instead of re-reading blind", async () => {
    const kv = mockKV();
    seedRows(kv, KV.crystals, 3);

    await listBounded(kv as never, KV.crystals, HINT); // cold: measures
    const afterFirst = kv.listCalls.length;
    await listBounded(kv as never, KV.crystals, HINT); // warm: still small

    // Small scope, so it is allowed to read again — but it consulted the
    // record first rather than guessing.
    expect(kv.listCalls.length).toBe(afterFirst + 1);
    const recorded = await readScopeSize(kv as never, KV.crystals);
    expect(recorded!.rows).toBe(3);
  });

  it("refuses on the cold call itself when the scope turns out to be huge", async () => {
    const kv = mockKV();
    // No record, not seeded: this is the one unguarded read. It must still
    // answer 413 rather than hand back a payload nobody can survive, and
    // it must record the size so the NEXT call refuses for free.
    seedRows(kv, KV.audit, 400, 60_000); // ~24 MB > 15 MiB ceiling

    const result = await listBounded(kv as never, KV.audit, HINT);

    expect(isOversized(result)).toBe(true);
    expect(kv.listCalls).toContain(KV.audit);

    const recorded = await readScopeSize(kv as never, KV.audit);
    expect(recorded!.bytes).toBeGreaterThan(SAFE_ENUMERATION_BYTES);

    // Second call refuses without reading.
    const before = kv.listCalls.length;
    const again = await listBounded(kv as never, KV.audit, HINT);
    expect(isOversized(again)).toBe(true);
    expect(kv.listCalls.length).toBe(before);
  });

  it("refuses a scope whose reads keep killing the worker before anything is recorded", async () => {
    // The case the size record alone cannot see. A payload big enough to
    // stall the heartbeat gets the invocation stopped mid-flight, so
    // recordScopeSize never runs and the scope stays unmeasured. Simulated
    // here by a list() that never returns normally.
    const kv = mockKV();
    const dead = {
      ...kv,
      list: async (scope: string) => {
        kv.listCalls.push(scope);
        throw new Error("Invocation stopped");
      },
    };

    // Attempt 1: unguarded cold read, dies.
    await expect(
      listBounded(dead as never, KV.semantic, HINT),
    ).rejects.toThrow(/Invocation stopped/);
    // Attempt 2: one retry is tolerated (could have been a deploy), dies.
    await expect(
      listBounded(dead as never, KV.semantic, HINT),
    ).rejects.toThrow(/Invocation stopped/);

    const readsBefore = kv.listCalls.length;

    // Attempt 3: refuses WITHOUT reading. Without the attempt marker this
    // would kill the worker again, forever.
    const result = await listBounded(dead as never, KV.semantic, HINT);
    expect(isOversized(result)).toBe(true);
    expect(kv.listCalls.length).toBe(readsBefore);
    if (isOversized(result)) {
      expect(result.error).toMatch(/never completed/i);
    }
  });

  it("clears the attempt marker after a read that survives", async () => {
    const kv = mockKV();
    seedRows(kv, KV.lessons, 2);

    await listBounded(kv as never, KV.lessons, HINT);
    const marker = await kv.get(KV.scopeSize, `attempt:${KV.lessons}`);
    expect(marker).toBeNull();

    // A healthy scope stays readable indefinitely.
    const again = await listBounded(kv as never, KV.lessons, HINT);
    expect(isOversized(again)).toBe(false);
  });
});
