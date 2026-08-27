import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { StateKV } from "../src/state/kv.js";
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

// Mirrors iii-sdk 0.11.2 `Sdk`: `trigger` arms a per-invocation timer from
// `timeoutMs ?? invocationTimeoutMs`, and `onSocketClose` tears down the
// socket without touching the in-flight invocation map. Verified against
// node_modules/iii-sdk/dist/index.mjs lines 360-405 and 570-577, and against
// the same routine in 0.20.0 and 0.22.1-rc.2.
function fakeSdk(invocationTimeoutMs = WORKER_INVOCATION_TIMEOUT_MS) {
  const pending = new Map<string, PendingInvocation>();
  let nextId = 0;

  return {
    pending,
    getMeter: () => ({}),
    closeSocket() {
      // onSocketClose(): removeAllListeners, terminate, schedule reconnect.
      // No invocation is settled here — that is the defect under test.
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
              `Invocation timeout after ${effectiveTimeout}ms: ${request.function_id}`,
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

  it("rejects an in-flight state write within the engine-primitive budget after the socket closes", async () => {
    const sdk = fakeSdk();
    const kv = new StateKV(boundEnginePrimitives(sdk) as never);

    const write = kv.set("scope", "key", { a: 1 });
    write.catch(() => {});
    expect(sdk.pending.size).toBe(1);

    sdk.closeSocket();

    await vi.advanceTimersByTimeAsync(30000);

    expect(await settled(write)).toBe("rejected");
    await expect(write).rejects.toThrow(/Invocation timeout after 30000ms/);
  });

  it("leaves the same write hanging when the sdk is unbounded", async () => {
    const sdk = fakeSdk();
    const kv = new StateKV(sdk as never);

    const write = kv.set("scope", "key", { a: 1 });
    write.catch(() => {});

    sdk.closeSocket();

    await vi.advanceTimersByTimeAsync(30000);

    expect(await settled(write)).toBe("pending");
  });

  it("leaves boot-path reads on the worker budget until the bound is armed", async () => {
    resetEnginePrimitiveBoundForTests();

    const sdk = fakeSdk();
    const kv = new StateKV(boundEnginePrimitives(sdk) as never);

    const read = kv.get("mem:index:bm25", "data:manifest");
    read.catch(() => {});

    // A cold engine has not accepted the worker yet. Observed in production:
    // 67 seconds from container start to "Worker registered", during which
    // every boot read must survive rather than fail fast.
    await vi.advanceTimersByTimeAsync(60000);
    expect(await settled(read)).toBe("pending");

    // The engine finally accepts the worker and the queued read completes,
    // which is the behaviour the 30 s bound was destroying at boot.
    sdk.settle("state::get", { value: { manifest: "ok" } });
    expect(await settled(read)).toBe("fulfilled");
  });

  it("keeps a slow but healthy llm trigger on the worker budget", async () => {
    const sdk = fakeSdk();
    const bounded = boundEnginePrimitives(sdk as never);

    const enrich = bounded.trigger<unknown, { ok: boolean }>({
      function_id: "mem::enrich",
      payload: {},
    });
    enrich.catch(() => {});

    await vi.advanceTimersByTimeAsync(60000);
    expect(await settled(enrich)).toBe("pending");

    await vi.advanceTimersByTimeAsync(60000);
    expect(await settled(enrich)).toBe("pending");

    sdk.settle("mem::enrich", { ok: true });
    await expect(enrich).resolves.toEqual({ ok: true });
  });

  it("keeps scope enumeration on the worker budget", async () => {
    const sdk = fakeSdk();
    const kv = new StateKV(boundEnginePrimitives(sdk) as never);

    const listing = kv.list("scope");
    listing.catch(() => {});

    await vi.advanceTimersByTimeAsync(60000);
    expect(await settled(listing)).toBe("pending");

    sdk.settle("state::list", ["a"]);
    await expect(listing).resolves.toEqual(["a"]);
  });

  it("honours an explicit caller timeout over the engine-primitive budget", async () => {
    const sdk = fakeSdk();
    const bounded = boundEnginePrimitives(sdk as never);

    const write = bounded.trigger({
      function_id: "state::set",
      payload: {},
      timeoutMs: 90000,
    });
    write.catch(() => {});

    await vi.advanceTimersByTimeAsync(30000);
    expect(await settled(write)).toBe("pending");

    await vi.advanceTimersByTimeAsync(60000);
    await expect(write).rejects.toThrow(/Invocation timeout after 90000ms/);
  });

  it("preserves sdk capabilities that agentmemory feature-detects", () => {
    const sdk = fakeSdk();
    const bounded = boundEnginePrimitives(sdk as never);

    expect("getMeter" in bounded).toBe(true);
    expect(typeof (bounded as unknown as { getMeter: unknown }).getMeter).toBe(
      "function",
    );
  });
});
