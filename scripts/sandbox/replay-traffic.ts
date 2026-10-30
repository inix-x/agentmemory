// Fork-only sandbox tool (never part of an upstream PR). Re-sends the target
// store's most recent 24 h of observations through POST /agentmemory/observe,
// one replay session per original session, and ends each replay session
// through /agentmemory/session/end after its last observation.
//
//   npx tsx scripts/sandbox/replay-traffic.ts --url <base> --bearer-file <path> --rate <obs/h> [--dry-run]
//
// The bearer file holds the token, or a curl header line
// ("Authorization: Bearer <token>"). The token never goes on the command line
// and is never printed.
//
// Fidelity: fork production observations carry no `source`, so payloads are
// rebuilt from the compressed fields (title, subtitle, facts, narrative,
// files). A replayed payload is smaller than the original hook payload.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const REPLAY_SESSION_PREFIX = "replay-";
export const WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 30_000;

interface StoredSession {
  id: string;
  project: string;
  cwd: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
}

interface StoredObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  title?: string;
  subtitle?: string;
  facts?: string[];
  narrative?: string;
  files?: string[];
}

export interface ReplayDeps {
  baseUrl: string;
  token: string;
  ratePerHour: number;
  runTag: string;
  dryRun?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ReplayResult {
  selected: number;
  sessions: number;
  delivered: number;
  failed: number;
  sessionsEnded: number;
  windowFrom: string | null;
  windowTo: string | null;
}

const TOOL_NAMES: Record<string, string> = {
  file_read: "Read",
  file_write: "Write",
  file_edit: "Edit",
  command_run: "Bash",
  search: "Grep",
  web_fetch: "WebFetch",
};

function activityTime(s: StoredSession): number {
  return Math.max(...[s.startedAt, s.updatedAt, s.endedAt].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite), -Infinity);
}

function observeBody(
  obs: StoredObservation,
  session: StoredSession,
  sessionId: string,
  eventId: string,
  timestamp: string,
): Record<string, unknown> {
  const text = [obs.narrative, ...(obs.facts ?? [])].filter(Boolean).join("\n");
  const base = { sessionId, project: session.project, cwd: session.cwd, timestamp, eventId };
  if (obs.type === "conversation") {
    return { ...base, hookType: "prompt_submit", data: { prompt: text || obs.title || "" } };
  }
  return {
    ...base,
    hookType: "post_tool_use",
    data: {
      tool_name: TOOL_NAMES[obs.type] ?? obs.type,
      tool_input: { title: obs.title, subtitle: obs.subtitle, files: obs.files ?? [] },
      tool_output: text,
    },
  };
}

export async function runReplay(deps: ReplayDeps, result?: ReplayResult): Promise<ReplayResult> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const base = deps.baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" };
  const out: ReplayResult = result ?? { selected: 0, sessions: 0, delivered: 0, failed: 0, sessionsEnded: 0, windowFrom: null, windowTo: null };

  const getJson = async (path: string): Promise<any> => {
    const res = await doFetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]} returned ${res.status}`);
    return res.json();
  };
  const post = async (path: string, body: unknown): Promise<boolean> => {
    try {
      const res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return true;
      log(`POST ${path} returned ${res.status}`);
    } catch (err) {
      log(`POST ${path} failed: ${err instanceof Error ? err.name : "error"}`);
    }
    return false;
  };

  // Sources: every non-replay session, paged. Replay sessions are excluded so
  // a later run never re-selects an earlier run's traffic as its window.
  const sessions: StoredSession[] = [];
  let cursor: string | null = null;
  do {
    const page: { sessions: StoredSession[]; nextCursor: string | null } = await getJson(
      `/agentmemory/sessions?agentId=*&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    sessions.push(...page.sessions.filter((s) => !s.id.startsWith(REPLAY_SESSION_PREFIX)));
    cursor = page.nextCursor;
  } while (cursor);

  // The window anchors on the store's newest session activity, not the wall
  // clock, because a restored store is a snapshot.
  const anchor = Math.max(...sessions.map(activityTime), -Infinity);
  if (!Number.isFinite(anchor)) return out;
  const cutoff = anchor - WINDOW_MS;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const selected: StoredObservation[] = [];
  for (const s of sessions) {
    if (activityTime(s) < cutoff) continue;
    const { observations } = await getJson(`/agentmemory/observations?agentId=*&sessionId=${encodeURIComponent(s.id)}`);
    for (const o of observations as StoredObservation[]) {
      const t = Date.parse(o.timestamp);
      if (t >= cutoff && t <= anchor) selected.push({ ...o, sessionId: s.id });
    }
  }
  // Original-time order interleaves sessions the way production saw them.
  selected.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
  const lastIndex = new Map<string, number>();
  selected.forEach((o, i) => lastIndex.set(o.sessionId, i));
  out.selected = selected.length;
  out.sessions = lastIndex.size;
  out.windowFrom = selected[0]?.timestamp ?? null;
  out.windowTo = selected.at(-1)?.timestamp ?? null;
  if (deps.dryRun) return out;

  // Each wait counts from the previous send's start, so a stall (a 503 hold,
  // a slow first boot) is never followed by a catch-up burst above the rate.
  const intervalMs = 3_600_000 / deps.ratePerHour;
  let lastSendAt: number | null = null;
  for (const [i, obs] of selected.entries()) {
    if (lastSendAt !== null) await sleep(Math.max(0, lastSendAt + intervalMs - now()));
    lastSendAt = now();
    const replaySessionId = `${REPLAY_SESSION_PREFIX}${deps.runTag}-${obs.sessionId}`;
    const body = observeBody(obs, byId.get(obs.sessionId)!, replaySessionId, `${REPLAY_SESSION_PREFIX}${deps.runTag}-${i}`, new Date(lastSendAt).toISOString());
    if (await post("/agentmemory/observe", body)) out.delivered++;
    else out.failed++;
    if (lastIndex.get(obs.sessionId) === i && (await post("/agentmemory/session/end", { sessionId: replaySessionId, final: true }))) {
      out.sessionsEnded++;
    }
    if ((i + 1) % 100 === 0) log(`progress ${i + 1}/${selected.length} delivered=${out.delivered} failed=${out.failed}`);
  }
  return out;
}

function readToken(path: string): string {
  return readFileSync(path, "utf8").trim().replace(/^Authorization:\s*/i, "").replace(/^Bearer\s+/i, "").trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      "bearer-file": { type: "string" },
      rate: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const rate = Number(values.rate);
  if (!values.url || !values["bearer-file"] || !(rate > 0)) {
    console.error("usage: replay-traffic.ts --url <base> --bearer-file <path> --rate <observations per hour> [--dry-run]");
    process.exit(2);
  }
  const result: ReplayResult = { selected: 0, sessions: 0, delivered: 0, failed: 0, sessionsEnded: 0, windowFrom: null, windowTo: null };
  const report = () => console.log(`REPLAY_RESULT ${JSON.stringify(result)}`);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(signal, () => {
      report();
      process.exit(code);
    });
  }
  await runReplay(
    {
      baseUrl: values.url,
      token: readToken(values["bearer-file"]),
      ratePerHour: rate,
      runTag: Date.now().toString(36),
      dryRun: values["dry-run"],
    },
    result,
  );
  report();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`replay failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
