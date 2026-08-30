import { describe, it, expect, vi, afterEach } from "vitest";
import { postWithRetry } from "../src/hooks/_post.js";

const URL = "http://localhost:3111/agentmemory/observe";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(responses: Array<Response | Error>) {
  const calls: string[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("postWithRetry", () => {
  it("sends once when the server accepts it", async () => {
    const { fn } = stubFetch([new Response(null, { status: 201 })]);

    await postWithRetry(URL, {}, "{}", { retryDelayMs: 1 });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  // The engine drops the worker socket periodically. During that window the
  // route is briefly unregistered and POST /agentmemory/observe answers 404.
  // Without a retry the observation is gone: the caller swallowed the error
  // and the hook process exited.
  it("retries a 404 and keeps the observation", async () => {
    const { fn } = stubFetch([
      new Response(null, { status: 404 }),
      new Response(null, { status: 201 }),
    ]);

    await postWithRetry(URL, {}, "{}", { retryDelayMs: 1 });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a 500", async () => {
    const { fn } = stubFetch([
      new Response(null, { status: 500 }),
      new Response(null, { status: 201 }),
    ]);

    await postWithRetry(URL, {}, "{}", { retryDelayMs: 1 });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a network error", async () => {
    const { fn } = stubFetch([
      new Error("ECONNRESET"),
      new Response(null, { status: 201 }),
    ]);

    await postWithRetry(URL, {}, "{}", { retryDelayMs: 1 });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry rather than looping", async () => {
    const { fn } = stubFetch([new Response(null, { status: 500 })]);

    await postWithRetry(URL, {}, "{}", { retryDelayMs: 1 });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("never rejects, so a caller cannot crash the hook", async () => {
    stubFetch([new Error("ECONNREFUSED")]);

    await expect(
      postWithRetry(URL, {}, "{}", { retryDelayMs: 1 }),
    ).resolves.toBeUndefined();
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

    await postWithRetry(URL, {}, "{}", { retryDelayMs: 1 });

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    // A reused signal would already be counting down, or aborted, by the
    // time the second attempt runs.
    expect(signals[0]).not.toBe(signals[1]);
  });
});
