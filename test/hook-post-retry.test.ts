import { describe, it, expect, vi, afterEach } from "vitest";
import { postWithRetry } from "../src/hooks/_post.js";

const ENDPOINT = "http://localhost:3111/agentmemory/observe";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(responses: Array<Response | Error>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("postWithRetry", () => {
  it("sends once when the server accepts it", async () => {
    const fn = stubFetch([new Response(null, { status: 201 })]);

    await postWithRetry(ENDPOINT, {}, "{}", 1);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  // The engine drops the worker socket periodically. During that window the
  // route is briefly unregistered and the POST answers 404, or an in-flight
  // state call dies and it answers 500. Without a retry the observation is
  // gone: the caller swallowed the error and the hook process exited.
  it.each([
    ["404", new Response(null, { status: 404 })],
    ["500", new Response(null, { status: 500 })],
    ["a network error", new Error("ECONNRESET")],
  ])("retries %s and keeps the observation", async (_label, failure) => {
    const fn = stubFetch([failure, new Response(null, { status: 201 })]);

    await postWithRetry(ENDPOINT, {}, "{}", 1);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Both inputs are load-bearing. A throw-only case leaves an unbounded loop
  // on a persistently bad status undetected, and vice versa.
  it.each([
    ["a bad status", new Response(null, { status: 500 })],
    ["a network error", new Error("ECONNREFUSED")],
  ])("stops after one retry and never rejects on %s", async (_l, failure) => {
    const fn = stubFetch([failure]);

    await expect(postWithRetry(ENDPOINT, {}, "{}", 1)).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives each attempt its own timeout signal", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal | undefined);
        return new Response(null, { status: 500 });
      }),
    );

    await postWithRetry(ENDPOINT, {}, "{}", 1);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    // A reused signal would already be counting down, or aborted, by the
    // time the second attempt runs.
    expect(signals[0]).not.toBe(signals[1]);
  });
});
