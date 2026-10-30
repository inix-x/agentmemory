import { describe, expect, it } from "vitest";
import { runReplay } from "../scripts/sandbox/replay-traffic.js";
import { isValidEventId } from "../src/capture/event-id.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-30T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const sessions = [
  { id: "sess-a", project: "p", cwd: "/a", startedAt: iso(-2 * HOUR), updatedAt: iso(0) },
  { id: "sess-b", project: "p", cwd: "/b", startedAt: iso(-3 * HOUR), endedAt: iso(-HOUR) },
  { id: "sess-old", project: "p", cwd: "/o", startedAt: iso(-50 * HOUR), endedAt: iso(-30 * HOUR) },
  // An earlier replay run, newer than everything: must not anchor or be re-sent.
  { id: "replay-x-sess-a", project: "p", cwd: "/a", startedAt: iso(HOUR), updatedAt: iso(5 * HOUR) },
];
const observations: Record<string, unknown[]> = {
  "sess-a": [
    { id: "a1", timestamp: iso(-2 * HOUR), type: "command_run", title: "ran tests", narrative: "n", facts: ["f"], files: ["x.ts"] },
    { id: "a2", timestamp: iso(-10 * 60_000), type: "conversation", title: "asked", narrative: "please fix" },
    { id: "a0", timestamp: iso(-25 * HOUR), type: "file_read", title: "outside the window" },
  ],
  "sess-b": [{ id: "b1", timestamp: iso(-90 * 60_000), type: "file_edit", title: "edited" }],
  "sess-old": [{ id: "o1", timestamp: iso(-40 * HOUR), type: "file_read", title: "old" }],
  "replay-x-sess-a": [{ id: "r1", timestamp: iso(4 * HOUR), type: "file_read", title: "replayed" }],
};

function fakeTarget(opts: { latencyMs?: (n: number) => number; observeStatus?: (n: number) => number } = {}) {
  let clock = 0;
  const posts: Array<{ path: string; body: any; at: number }> = [];
  const auth: string[] = [];
  let observeCount = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    auth.push(String((init?.headers as Record<string, string>).Authorization));
    if (!init?.method) {
      if (u.pathname === "/agentmemory/sessions") {
        expect(u.searchParams.get("agentId")).toBe("*");
        const cursor = u.searchParams.get("cursor");
        const page = cursor ? sessions.slice(2) : sessions.slice(0, 2);
        return Response.json({ sessions: page, nextCursor: cursor ? null : "next" });
      }
      expect(u.searchParams.get("agentId")).toBe("*");
      return Response.json({ observations: observations[u.searchParams.get("sessionId")!] ?? [] });
    }
    const body = JSON.parse(String(init.body));
    posts.push({ path: u.pathname, body, at: clock });
    if (u.pathname === "/agentmemory/observe") {
      const n = observeCount++;
      clock += opts.latencyMs?.(n) ?? 0;
      return new Response("{}", { status: opts.observeStatus?.(n) ?? 201 });
    }
    return Response.json({ success: true, ended: true });
  }) as typeof fetch;
  return {
    posts,
    auth,
    deps: {
      baseUrl: "https://sandbox.example/",
      token: "tok",
      runTag: "run1",
      fetch: fetchImpl,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      log: () => {},
    },
  };
}

describe("sandbox replay-traffic", () => {
  it("re-sends the newest 24 h interleaved by original time, ends each session after its last observation", async () => {
    const t = fakeTarget();
    const result = await runReplay({ ...t.deps, ratePerHour: 3600 });

    expect(t.posts.map((p) => [p.path.replace("/agentmemory/", ""), p.body.sessionId])).toEqual([
      ["observe", "replay-run1-sess-a"],
      ["observe", "replay-run1-sess-b"],
      ["session/end", "replay-run1-sess-b"],
      ["observe", "replay-run1-sess-a"],
      ["session/end", "replay-run1-sess-a"],
    ]);
    const observes = t.posts.filter((p) => p.path === "/agentmemory/observe").map((p) => p.body);
    expect(observes.map((b) => b.hookType)).toEqual(["post_tool_use", "post_tool_use", "prompt_submit"]);
    expect(observes[0]).toMatchObject({
      project: "p",
      cwd: "/a",
      data: { tool_name: "Bash", tool_input: { title: "ran tests", files: ["x.ts"] }, tool_output: "n\nf" },
    });
    expect(observes[2].data).toEqual({ prompt: "please fix" });
    expect(observes.every((b) => isValidEventId(b.eventId))).toBe(true);
    expect(new Set(observes.map((b) => b.eventId)).size).toBe(3);
    expect(t.posts.find((p) => p.path === "/agentmemory/session/end")!.body.final).toBe(true);
    expect(new Set(t.auth)).toEqual(new Set(["Bearer tok"]));
    expect(result).toMatchObject({ selected: 3, sessions: 2, delivered: 3, failed: 0, sessionsEnded: 2 });
  });

  it("paces from the previous send, never bursts after a stall, and counts failures", async () => {
    const t = fakeTarget({ latencyMs: (n) => (n === 0 ? 5000 : 0), observeStatus: (n) => (n === 1 ? 503 : 201) });
    const result = await runReplay({ ...t.deps, ratePerHour: 3600 });

    const sendTimes = t.posts.filter((p) => p.path === "/agentmemory/observe").map((p) => p.at);
    // 1 s interval; the first send stalls 5 s. The next goes at once, the third waits a full interval.
    expect(sendTimes).toEqual([0, 5000, 6000]);
    expect(result).toMatchObject({ delivered: 2, failed: 1, sessionsEnded: 2 });
  });

  it("dry run selects without posting", async () => {
    const t = fakeTarget();
    const result = await runReplay({ ...t.deps, ratePerHour: 3600, dryRun: true });
    expect(t.posts).toEqual([]);
    expect(result).toMatchObject({ selected: 3, delivered: 0, windowFrom: iso(-2 * HOUR), windowTo: iso(-10 * 60_000) });
  });
});
