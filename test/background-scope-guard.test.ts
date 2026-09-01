import { describe, it, expect, vi, beforeEach } from "vitest";
import { KV } from "../src/state/schema.js";
import {
  listBoundedOrSkip,
  SAFE_ENUMERATION_BYTES,
} from "../src/state/scope-size.js";

const warn = vi.fn();
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn() },
}));

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

describe("background jobs skip an over-ceiling scope instead of killing the worker", () => {
  beforeEach(() => warn.mockClear());

  it("skips a seeded-oversized scope WITHOUT reading it, and warns", async () => {
    // KV.memories is seeded at 38.5 MB. auto-forget (hourly) and
    // consolidate (2-hourly) both enumerated it unbounded, which is what
    // took the worker down at 06:15 and cost 53 observations over 4h.
    const kv = mockKV();
    const rows = await listBoundedOrSkip(kv as never, KV.memories, "mem::auto-forget");

    expect(rows).toEqual([]);
    expect(kv.listCalls).not.toContain(KV.memories);
    expect(warn).toHaveBeenCalledWith(
      "Background scope enumeration refused",
      expect.objectContaining({ caller: "mem::auto-forget", scope: KV.memories }),
    );
  });

  it("returns rows normally for a scope under the ceiling, and does not warn", async () => {
    const kv = mockKV();
    kv.store.set(KV.lessons, new Map([["a", { id: "a" }], ["b", { id: "b" }]]));

    const rows = await listBoundedOrSkip(kv as never, KV.lessons, "mem::reflect");

    expect(rows).toHaveLength(2);
    expect(kv.listCalls).toContain(KV.lessons);
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades to an empty array rather than throwing when the read dies", async () => {
    // A background job must never propagate a worker-death error into the
    // timer callback; the existing callers all used .catch(() => []).
    const kv = mockKV();
    const dead = {
      ...kv,
      list: async () => {
        throw new Error("Invocation stopped");
      },
    };

    const rows = await listBoundedOrSkip(dead as never, KV.sessions, "mem::consolidate");

    expect(rows).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Background scope read failed",
      expect.objectContaining({ caller: "mem::consolidate" }),
    );
  });

  it("records the size so a second call refuses without reading", async () => {
    const kv = mockKV();
    const big = new Map<string, unknown>();
    for (let i = 0; i < 400; i++) big.set(`k${i}`, { id: `k${i}`, blob: "x".repeat(60_000) });
    kv.store.set(KV.accessLog, big); // ~24 MB > 15 MiB

    const first = await listBoundedOrSkip(kv as never, KV.accessLog, "mem::retention");
    expect(first).toEqual([]); // over ceiling once measured
    const reads = kv.listCalls.length;

    const second = await listBoundedOrSkip(kv as never, KV.accessLog, "mem::retention");
    expect(second).toEqual([]);
    expect(kv.listCalls.length).toBe(reads); // refused for free
  });

  it("SAFE_ENUMERATION_BYTES is the shared 15 MiB ceiling", () => {
    expect(SAFE_ENUMERATION_BYTES).toBe(15 * 1024 * 1024);
  });
});
