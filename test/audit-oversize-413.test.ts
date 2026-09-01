import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { KV } from "../src/state/schema.js";
import { SAFE_ENUMERATION_BYTES } from "../src/state/scope-size.js";
import { registerGovernanceFunction } from "../src/functions/governance.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";

// /agentmemory/audit was 125 of the service's 136 5xx per hour (92.6%),
// every one of them a 500 in ~0.12s — the same latency as a healthy
// /health 200. That speed is the tell: listBounded refuses off the
// recorded scope size and never reaches the kv.list, so the guard is
// working and only the response mapping is wrong. queryAudit threw the
// refusal instead of returning it, and the throw escaped api::audit.
//
// scope-size.ts says the intended contract in its own docstring:
// "Returns OversizedPayload instead of throwing so callers can answer
// 413 the way api::mesh-export already does."
//
// This test drives the real chain — api::audit -> sdk.trigger ->
// mem::audit-query -> queryAudit -> listBounded -> the 413 branch —
// rather than asserting on the source text, so a break anywhere in that
// wiring fails here. Every other api-level test in this repo greps
// api.ts as a string, which cannot fail when the wiring breaks.
//
// What it does NOT cover: the mock's trigger hands the object straight
// back by reference, so nothing here exercises serialization across the
// real engine boundary. That the boundary preserves a plain object is
// evidenced in production code instead — api::session::start reads
// contextResult.context off a mem::context result (api.ts) on every
// session start.

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
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

function mockSdk() {
  const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: (id: string, fn: (payload?: unknown) => Promise<unknown>) => {
      handlers.set(id, fn);
    },
    registerTrigger: () => {},
    trigger: async (opts: { function_id: string; payload?: unknown }) => {
      const fn = handlers.get(opts.function_id);
      if (!fn) throw new Error(`no handler registered for ${opts.function_id}`);
      return fn(opts.payload);
    },
  };
  return { sdk, handlers };
}

type Response = { status_code: number; body?: unknown };

describe("/agentmemory/audit answers 413 on an oversized audit scope", () => {
  let kv: ReturnType<typeof mockKV>;
  let handlers: Map<string, (payload?: unknown) => Promise<unknown>>;

  beforeEach(() => {
    kv = mockKV();
    const m = mockSdk();
    handlers = m.handlers;
    // No secret, so checkAuth returns null and we reach the handler body.
    registerGovernanceFunction(m.sdk as never, kv as never);
    registerApiTriggers(m.sdk as never, kv as never);
    registerMcpEndpoints(m.sdk as never, kv as never);
  });

  async function oversizeAuditScope() {
    await kv.set(KV.scopeSize, KV.audit, {
      rows: 1,
      bytes: SAFE_ENUMERATION_BYTES + 1,
      measuredAt: new Date().toISOString(),
    });
  }

  async function callAudit(): Promise<Response> {
    const fn = handlers.get("api::audit");
    expect(fn, "api::audit must be registered").toBeDefined();
    return (await fn!({ query_params: { limit: "5" } })) as Response;
  }

  it("returns 413 carrying the refusal, not 500, when the scope is over the ceiling", async () => {
    // Exactly how production is: the scope size is already recorded over
    // the ceiling, so listBounded refuses before doing any kv.list.
    await oversizeAuditScope();

    const res = await callAudit();
    const body = res.body as { bytes?: number; limitBytes?: number };

    expect(res.status_code).toBe(413);
    // Not asserted: body.oversized and typeof body.error. Neither can
    // fail while the 413 above passes — api.ts returns the same object it
    // ran isOversized() on, and isOversized IS `oversized === true`.
    // bytes/limitBytes are independent, so they are worth asserting.
    expect(body.bytes).toBeGreaterThan(SAFE_ENUMERATION_BYTES);
    expect(body.limitBytes).toBe(SAFE_ENUMERATION_BYTES);
  });

  it("still answers 200 when the scope is within the ceiling", async () => {
    // Guard against over-correcting into a blanket 413.
    const res = await callAudit();

    expect(res.status_code).toBe(200);
    expect((res.body as { success?: boolean }).success).toBe(true);
  });

  // Removing the throw means the try/catch around the MCP memory_audit
  // handler no longer fires on a refusal. Without an explicit isOversized
  // branch there, a refusal renders as an ordinary successful result —
  // trading a correctly-flagged error for a silently-wrong success.
  it("MCP memory_audit reports the refusal as an error, not a success", async () => {
    await oversizeAuditScope();

    const call = handlers.get("mcp::tools::call");
    expect(call, "mcp::tools::call must be registered").toBeDefined();
    const res = (await call!({
      body: { name: "memory_audit", arguments: {} },
    })) as { status_code: number; body: { isError?: boolean; content?: { text?: string }[] } };

    expect(res.body.isError).toBe(true);
    // The reason has to reach the caller, not just a generic failure.
    expect(res.body.content?.[0]?.text ?? "").toMatch(/too large to enumerate/);
  });

  it("MCP memory_audit still succeeds when the scope is within the ceiling", async () => {
    const call = handlers.get("mcp::tools::call");
    const res = (await call!({
      body: { name: "memory_audit", arguments: {} },
    })) as { status_code: number; body: { isError?: boolean } };

    expect(res.body.isError).toBeUndefined();
  });
});
