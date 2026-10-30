import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { StateKV } from "../src/state/kv.js";
import { withWriteScrubbing } from "../src/functions/privacy.js";
import {
  armEnginePrimitiveBound,
  boundEnginePrimitives,
  resetEnginePrimitiveBoundForTests,
} from "../src/sdk-timeouts.js";

const WORKER_INVOCATION_TIMEOUT_MS = 180000;

type PendingInvocation = {
  functionId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Mirrors iii-sdk 0.25.0 `invokeRemote`: `trigger` arms a per-invocation timer
// from `timeoutMs ?? invocationTimeoutMs`, and `onSocketClose` tears down the
// socket without settling the in-flight invocation map. Verified against
// node_modules/iii-sdk/dist/index.mjs `invokeRemote` and `onSocketClose`.
function fakeSdk(invocationTimeoutMs = WORKER_INVOCATION_TIMEOUT_MS) {
  const pending = new Map<string, PendingInvocation>();
  let nextId = 0;

  return {
    pending,
    getMeter: () => ({}),
    registerFunction: () => ({}),
    closeSocket() {
      // onSocketClose(): stop heartbeat, terminate, schedule reconnect.
      // No invocation is settled here -- that is the defect under test.
    },
    settle(functionId: string, value: unknown) {
      for (const [id, invocation] of pending) {
        if (invocation.functionId !== functionId) continue;
        clearTimeout(invocation.timer);
        pending.delete(id);
        invocation.resolve(value);
        return;
      }
      throw new Error(`no in-flight invocation for ${functionId}`);
    },
    trigger(request: { function_id: string; timeoutMs?: number }) {
      const id = String(nextId++);
      const effectiveTimeout = request.timeoutMs ?? invocationTimeoutMs;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `invocation timed out after ${effectiveTimeout}ms: ${request.function_id}`,
            ),
          );
        }, effectiveTimeout);
        pending.set(id, {
          functionId: request.function_id,
          resolve,
          reject,
          timer,
        });
      });
    },
  };
}

// The production stack: src/index.ts wraps the scrubbing proxy, so the bound
// must survive sitting on top of a Proxy rather than a plain object.
function productionStack(sdk: ReturnType<typeof fakeSdk>) {
  return boundEnginePrimitives(withWriteScrubbing(sdk) as never);
}

async function settled(promise: Promise<unknown>) {
  let state = "pending";
  promise.then(
    () => {
      state = "fulfilled";
    },
    () => {
      state = "rejected";
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  return state;
}

describe("engine primitive trigger budget", () => {
  beforeEach(() => {
    resetEnginePrimitiveBoundForTests();
    armEnginePrimitiveBound();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an in-flight state read within 30 s after the socket closes", async () => {
    const sdk = fakeSdk();
    const kv = new StateKV(productionStack(sdk));

    const read = kv.get("mem:sessions", "ses_1");
    read.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.pending.size).toBe(1);

    sdk.closeSocket();

    await vi.advanceTimersByTimeAsync(29999);
    expect(await settled(read)).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).rejects.toThrow(/invocation timed out after 30000ms/);
  });

  it("rejects an in-flight state write within 30 s after the socket closes", async () => {
    const sdk = fakeSdk();
    const kv = new StateKV(productionStack(sdk));

    const write = kv.set("mem:sessions", "ses_1", { a: 1 });
    write.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.pending.size).toBe(1);

    sdk.closeSocket();

    await vi.advanceTimersByTimeAsync(30000);
    await expect(write).rejects.toThrow(/invocation timed out after 30000ms/);
  });

  it("leaves the same read hanging when the sdk is unbounded", async () => {
    const sdk = fakeSdk();
    const kv = new StateKV(withWriteScrubbing(sdk) as never);

    const read = kv.get("mem:sessions", "ses_1");
    read.catch(() => {});

    sdk.closeSocket();

    await vi.advanceTimersByTimeAsync(30000);
    expect(await settled(read)).toBe("pending");
  });

  it("leaves boot-path reads on the worker budget until the bound is armed", async () => {
    resetEnginePrimitiveBoundForTests();

    const sdk = fakeSdk();
    const kv = new StateKV(productionStack(sdk));

    const read = kv.get("mem:index:bm25", "data:manifest");
    read.catch(() => {});

    // A cold engine has not accepted the worker yet. The fork measured 67 s
    // from container start to "Worker registered", and every boot read must
    // survive that window rather than fail fast.
    await vi.advanceTimersByTimeAsync(60000);
    expect(await settled(read)).toBe("pending");

    sdk.settle("state::get", { manifest: "ok" });
    await expect(read).resolves.toEqual({ manifest: "ok" });
  });

  it("keeps a slow but healthy llm trigger on the worker budget", async () => {
    const sdk = fakeSdk();
    const bounded = productionStack(sdk);

    const enrich = bounded.trigger<unknown, { ok: boolean }>({
      function_id: "mem::enrich",
      payload: {},
    });
    enrich.catch(() => {});

    await vi.advanceTimersByTimeAsync(120000);
    expect(await settled(enrich)).toBe("pending");

    sdk.settle("mem::enrich", { ok: true });
    await expect(enrich).resolves.toEqual({ ok: true });
  });

  it.each(["state::list", "state::list_groups"])(
    "keeps %s on the worker budget",
    async (functionId) => {
      const sdk = fakeSdk();
      const bounded = productionStack(sdk);

      const listing = bounded.trigger({ function_id: functionId, payload: {} });
      listing.catch(() => {});

      await vi.advanceTimersByTimeAsync(60000);
      expect(await settled(listing)).toBe("pending");

      sdk.settle(functionId, ["a"]);
      await expect(listing).resolves.toEqual(["a"]);
    },
  );

  it("honours an explicit caller timeout over the engine-primitive budget", async () => {
    const sdk = fakeSdk();
    const bounded = productionStack(sdk);

    const write = bounded.trigger({
      function_id: "state::set",
      payload: {},
      timeoutMs: 90000,
    });
    write.catch(() => {});

    await vi.advanceTimersByTimeAsync(30000);
    expect(await settled(write)).toBe("pending");

    await vi.advanceTimersByTimeAsync(60000);
    await expect(write).rejects.toThrow(/invocation timed out after 90000ms/);
  });

  it("keeps the rest of the sdk reachable through the wrapper", () => {
    const sdk = fakeSdk();
    const bounded = productionStack(sdk);

    expect(typeof (bounded as unknown as { getMeter: unknown }).getMeter).toBe(
      "function",
    );
    expect(typeof bounded.registerFunction).toBe("function");
  });
});
