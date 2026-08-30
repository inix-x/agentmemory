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

    await postWithRetry(ENDPOINT, {}, "{}", 8);

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

    await postWithRetry(ENDPOINT, {}, "{}", 8);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Both inputs are load-bearing. A throw-only case leaves an unbounded loop
  // on a persistently bad status undetected, and vice versa.
  it.each([
    ["a bad status", new Response(null, { status: 500 })],
    ["a network error", new Error("ECONNREFUSED")],
  ])("stops after one retry and never rejects on %s", async (_l, failure) => {
    const fn = stubFetch([failure]);

    await expect(postWithRetry(ENDPOINT, {}, "{}", 8)).resolves.toBeUndefined();
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

    await postWithRetry(ENDPOINT, {}, "{}", 8);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    // A reused signal would already be counting down, or aborted, by the
    // time the second attempt runs.
    expect(signals[0]).not.toBe(signals[1]);
  });

  // Both attempts and the delay between them have to fit inside the caller's
  // exit budget. A per-attempt timeout longer than the budget means a slow
  // first attempt is killed by the exit timer before the retry can run, which
  // is exactly the case the retry exists for.
  it("fits both attempts inside the caller's budget", async () => {
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    stubFetch([new Response(null, { status: 500 })]);

    await postWithRetry(ENDPOINT, {}, "{}", 1000);

    expect(timeouts).toHaveLength(2);
    const delay = Math.min(250, Math.floor(1000 / 8));
    expect(timeouts[0] * 2 + delay).toBeLessThanOrEqual(1000);
    vi.restoreAllMocks();
  });

  // A timeout or abort leaves the outcome unknown: the server may have written
  // the observation and simply not answered in time. observe.ts records its
  // dedup hash only AFTER the write completes, so a retry here would create a
  // second observation. Certain non-delivery retries; ambiguity does not.
  it.each([
    ["TimeoutError", "TimeoutError"],
    ["AbortError", "AbortError"],
  ])("does not retry after a client %s", async (_l, name) => {
    const err = new Error("aborted");
    err.name = name;
    const fn = stubFetch([err]);

    await expect(postWithRetry(ENDPOINT, {}, "{}", 8)).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
