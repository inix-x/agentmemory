import type { AuditEntry } from "../types.js";
import { KV, generateId } from "../state/schema.js";
import { listBounded, isOversized } from "../state/scope-size.js";
import type { OversizedPayload } from "../state/frame-guard.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { getAuditRetentionMonths } from "../config.js";

// Audit partitioning (U6 of the memory-reduction ladder).
//
// Rows are written to KV.auditMonth(now), one scope per UTC month. The legacy
// mem:audit scope is over the enumeration guard in production and cannot be
// listed, rotated, or trimmed from inside the process; it is retired at boot
// by deploy/*/entrypoint.sh. Queries read the current and previous partition,
// which is one fewer month than retention keeps, so a partition being deleted
// on the timer is never one a query is reading.

// Audit coverage policy (issue #125).
//
// Every structural deletion of a memory, observation, session, or
// semantic row MUST call recordAudit. Two shapes are allowed, keyed to
// whether the caller is scoped or bulk:
//
//   Scoped deletions — a user-visible, per-call action removing a
//   bounded set of items. Emit ONE audit row per call with targetIds
//   populated. Examples: mem::governance-delete, mem::forget.
//
//   Bulk deletions — automatic sweeps (retention, TTL eviction,
//   auto-forget) that can remove hundreds of rows per invocation.
//   Emit ONE batched audit row per invocation with targetIds listing
//   every removed id and details.evicted holding the count. Per-item
//   audit rows would flood the audit log during routine sweeps.
//
//   Either shape is required; silent deletes are not acceptable.
//
// operation field:
//   - "delete"          — permanent removal (governance, retention sweep, evict).
//   - "forget"          — forget/removal flows. Scoped when emitted by
//                         mem::forget (user-initiated); bulk-batched when
//                         emitted by mem::auto-forget (automatic sweep).
//   - everything else   — see AuditEntry["operation"] union in src/types.ts.
//
// When adding a new deletion path, add an explicit recordAudit call
// BEFORE kv.delete(...) and match one of the two shapes above.

export async function recordAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<AuditEntry> {
  const now = new Date();
  const entry: AuditEntry = {
    id: generateId("aud"),
    timestamp: now.toISOString(),
    operation,
    userId,
    functionId,
    targetIds,
    details,
    qualityScore,
  };
  await kv.set(KV.auditMonth(now), entry.id, entry);
  return entry;
}

// The partitions a query reads: this month and last. A row written seconds
// before a month boundary is in last month's scope, so reading one partition
// would lose the most recent rows exactly when they matter.
export function auditQueryScopes(now = new Date()): string[] {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [KV.auditMonth(now), KV.auditMonth(prev)];
}

// Deletes every row in partitions older than the retention window. Whole-scope
// deletion is the one cheap delete the engine offers: when a scope's last key
// goes, the save loop drops the file. Bounded by walking the months between the
// retention cutoff and a floor rather than enumerating scope names, which the
// engine cannot do.
export async function rotateAuditPartitions(
  kv: StateKV,
  now = new Date(),
  retentionMonths = getAuditRetentionMonths(),
): Promise<{ partitionsEmptied: number; rowsDeleted: number }> {
  let partitionsEmptied = 0;
  let rowsDeleted = 0;
  // Nothing wrote a monthly partition before U6 shipped, so there is no
  // reason to look back further than a year past the cutoff.
  const LOOKBACK_MONTHS = 12;
  for (let back = retentionMonths; back < retentionMonths + LOOKBACK_MONTHS; back++) {
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const scope = KV.auditMonth(at);
    let rows: AuditEntry[];
    try {
      rows = await kv.list<AuditEntry>(scope);
    } catch (err) {
      logger.warn("audit rotation: partition read failed", {
        scope,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (rows.length === 0) continue;
    for (const row of rows) {
      try {
        await kv.delete(scope, row.id);
        rowsDeleted++;
      } catch (err) {
        logger.warn("audit rotation: row delete failed", {
          scope,
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    partitionsEmptied++;
  }
  if (partitionsEmptied > 0) {
    logger.info("audit rotation complete", { partitionsEmptied, rowsDeleted });
  }
  return { partitionsEmptied, rowsDeleted };
}

export async function safeAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<void> {
  try {
    await recordAudit(kv, operation, functionId, targetIds, details, qualityScore, userId);
  } catch (err) {
    try {
      logger.warn("audit write failed", {
        functionId,
        operation,
        targetIds,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

export async function queryAudit(
  kv: StateKV,
  filter?: {
    operation?: AuditEntry["operation"];
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<AuditEntry[] | OversizedPayload> {
  // The limit below is applied AFTER this read, so it bounds the response
  // and not the enumeration. On a large audit scope that inbound frame is
  // what stalls the worker heartbeat, which is why /agentmemory/audit was
  // the second-worst 5xx source in production. Refuse rather than pay it.
  //
  // Two monthly partitions instead of the one unbounded scope. Each is at
  // most a month of rows, so the guard is a ceiling that should not be hit;
  // if a partition does trip it, the refusal is handed back the same way.
  const all: AuditEntry[] = [];
  for (const scope of auditQueryScopes()) {
    const listed = await listBounded<AuditEntry>(
      kv,
      scope,
      "narrow with ?operation, or lower AUDIT_RETENTION_MONTHS; this partition is too large to enumerate",
    );
    if (isOversized(listed)) {
      // Hand the refusal back rather than throwing it. Once the other 5xx
      // sources were fixed this became the largest by far, 125 of 136 per
      // hour, every one a correct refusal reported as a server fault.
      // Callers must branch on isOversized(); see listBounded's contract.
      return listed;
    }
    all.push(...listed);
  }
  let entries = [...all].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  if (filter?.operation) {
    entries = entries.filter((e) => e.operation === filter.operation);
  }
  if (filter?.dateFrom) {
    const from = new Date(filter.dateFrom).getTime();
    if (Number.isNaN(from)) {
      throw new Error(`Invalid dateFrom: ${filter.dateFrom}`);
    }
    entries = entries.filter((e) => new Date(e.timestamp).getTime() >= from);
  }
  if (filter?.dateTo) {
    const to = new Date(filter.dateTo).getTime();
    if (Number.isNaN(to)) {
      throw new Error(`Invalid dateTo: ${filter.dateTo}`);
    }
    entries = entries.filter((e) => new Date(e.timestamp).getTime() <= to);
  }

  return entries.slice(0, filter?.limit || 100);
}
