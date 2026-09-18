import type { ISdk } from "iii-sdk";
import type {
  GraphNode,
  GraphEdge,
  GraphBatch,
  GraphQueryResult,
  GraphSnapshot,
  GraphSnapshotNode,
  GraphSnapshotEdge,
  CompressedObservation,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  GRAPH_EXTRACTION_SYSTEM,
  buildGraphExtractionPrompt,
} from "../prompts/graph-extraction.js";
import {
  isGraphExtractionEnabled,
  isGraphWriteEnabled,
  getGraphProvenanceMode,
  getGraphRowBatchCap,
} from "../config.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import {
  payloadByteLength,
  checkPayloadFrameSize,
  FRAME_LIMIT_BYTES,
} from "../state/frame-guard.js";
import type { OversizedPayload } from "../state/frame-guard.js";
import {
  newIndexDelta,
  recordEdgeAdjacency,
  recordNodeName,
  recordRowObservations,
  flushIndexDelta,
  type GraphIndexDelta,
  type GuardedWrite,
} from "../state/graph-store.js";

// #753: keep the response payload below the iii state channel ceiling.
// 500 nodes + their incident edges hold well under the limit on the
// reported 11k-node / 28k-edge corpus, and 5,000 is the upper bound a
// caller can request explicitly. Tuned conservatively because edges
// fan out faster than nodes.
const DEFAULT_GRAPH_QUERY_LIMIT = 500;
const MAX_GRAPH_QUERY_LIMIT = 5000;

// topNodes has always been capped and evicted; topEdges was appended to
// without bound, so the snapshot -- read on every viewer tab load -- grew with
// every edge whose endpoints happened to both be top nodes. Sized like
// topNodes: a full top-N subgraph rarely carries more edges than nodes times a
// small constant, and past that the lowest-weight edge is the one to lose.
const SNAPSHOT_TOP_EDGES = DEFAULT_GRAPH_QUERY_LIMIT * 2;

// #814: the precomputed snapshot covers the top-degree subgraph used by
// the empty-body / nodeType-only branch — the path the viewer hits on
// tab load. Sized to match the default query limit so the snapshot can
// service a default-cap request without falling back to live
// enumeration. Aggregate stats (nodesByType / edgesByType) are computed
// fresh during rebuild and stored alongside.
const SNAPSHOT_TOP_NODES = DEFAULT_GRAPH_QUERY_LIMIT;
export const SNAPSHOT_KEY = "current";

// R2: the snapshot is bounded by bytes, not only by row counts. Row caps did not
// hold it: 500 topNodes reached 14.2 MB because a row's size is unbounded, and
// the write went over the engine frame. 4 MiB sits well under SAFE_PAYLOAD_BYTES
// (15 MiB) because persistGraphDelta also reads the snapshot inbound and
// StateKV.set echoes the value back, so a successful write pays its bytes twice.
export const SNAPSHOT_BUDGET_BYTES = 4 * 1024 * 1024;

// SNAPSHOT_TOP_EDGES caps pushes, and snapshotPushEdgeIfBothInTop only evicts one
// to push one, so an array that grew past the cap under an earlier build keeps
// its length forever on the incremental path. Bring it down wherever a snapshot
// is loaded or built, by weight, which is the same key the eviction uses.
function truncateTopEdges(snap: GraphSnapshot): GraphSnapshot {
  if (snap.topEdges.length > SNAPSHOT_TOP_EDGES) {
    snap.topEdges = [...snap.topEdges]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, SNAPSHOT_TOP_EDGES);
  }
  return snap;
}

// Drops the lowest-degree node and the lowest-weight edge until the serialized
// snapshot fits. topNodes is held sorted by degree descending, so its tail is the
// cheapest node to lose. Returns the final size.
//
// ponytail: re-serializes the whole snapshot per pass. At the measured projected
// size (about 380 KB against a 4 MiB budget) the loop does not run at all; it
// exists so the bound still holds at 20x this corpus. Proportional dropping
// keeps it to a handful of passes. Make it incremental only if a profile ever
// shows it running hot.
function shrinkSnapshotToBudget(snap: GraphSnapshot): number {
  let bytes = payloadByteLength(snap);
  while (
    bytes > SNAPSHOT_BUDGET_BYTES &&
    (snap.topNodes.length > 0 || snap.topEdges.length > 0)
  ) {
    // Drop in proportion to the overshoot rather than one row at a time. The
    // measurement re-serializes the whole snapshot, so one-at-a-time is
    // O(rows x bytes) and costs seconds inside the extract on the corpus that
    // actually needs it. At least one row goes per pass, so this terminates.
    const keep = SNAPSHOT_BUDGET_BYTES / bytes;
    const dropNodes = Math.max(
      1,
      snap.topNodes.length - Math.floor(snap.topNodes.length * keep),
    );
    const dropEdges = Math.max(
      1,
      snap.topEdges.length - Math.floor(snap.topEdges.length * keep),
    );
    for (let i = 0; i < dropNodes && snap.topNodes.length > 0; i++) {
      const dropped = snap.topNodes.pop();
      if (dropped) delete snap.topDegrees[dropped.id];
    }
    if (snap.topEdges.length > 0) {
      snap.topEdges.sort((a, b) => b.weight - a.weight);
      snap.topEdges.length = Math.max(0, snap.topEdges.length - dropEdges);
    }
    bytes = payloadByteLength(snap);
  }
  return bytes;
}

// `state::list` over a 75K-node scope can exceed the iii invocation
// timeout. The query handler races the enumeration against this budget
// and falls back to the snapshot (or a warning envelope) when the live
// path is too slow. 6000ms leaves headroom under the default 8s engine
// invocation deadline.
const LIVE_ENUMERATION_BUDGET_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label}: exceeded ${ms}ms budget`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

function emptySnapshot(): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date(0).toISOString(),
    dirty: true,
  };
}

async function readSnapshot(kv: StateKV): Promise<GraphSnapshot | null> {
  try {
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    if (snap && typeof snap === "object" && snap.version === 1) {
      return truncateTopEdges(snap);
    }
    return null;
  } catch (err) {
    logger.warn("Graph snapshot read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function buildSnapshotFromArrays(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphSnapshot {
  const liveNodes = nodes.filter((n) => !n.stale);
  const liveEdges = edges.filter((e) => !e.stale);
  // Build the global degree map once so we can both rank by it AND
  // snapshot the per-top-node values into topDegrees for synchronous
  // re-sort after incremental edge writes.
  const degree = new Map<string, number>();
  for (const e of liveEdges) {
    degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
    degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
  }
  const ranked = [...liveNodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, SNAPSHOT_TOP_NODES);
  const rankedIds = new Set(ranked.map((n) => n.id));
  const topEdges = liveEdges.filter(
    (e) => rankedIds.has(e.sourceNodeId) && rankedIds.has(e.targetNodeId),
  );
  const topDegrees: Record<string, number> = {};
  for (const n of ranked) {
    topDegrees[n.id] = degree.get(n.id) ?? 0;
  }
  const nodesByType: Record<string, number> = {};
  for (const n of liveNodes) {
    nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
  }
  const edgesByType: Record<string, number> = {};
  for (const e of liveEdges) {
    edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
  }
  const snap: GraphSnapshot = {
    version: 1,
    topNodes: ranked.map(snapshotNode),
    topEdges: topEdges.map(snapshotEdge),
    topDegrees,
    stats: {
      totalNodes: liveNodes.length,
      totalEdges: liveEdges.length,
      nodesByType,
      edgesByType,
      nodeRowBytes: meanRowBytes(liveNodes.slice(0, ROW_BYTE_SAMPLE)),
      edgeRowBytes: meanRowBytes(liveEdges.slice(0, ROW_BYTE_SAMPLE)),
    },
    updatedAt: new Date().toISOString(),
    dirty: false,
  };
  // The rebuild path filters topEdges straight out of liveEdges with no cap, so
  // it is where an over-cap array comes from in the first place.
  truncateTopEdges(snap);
  shrinkSnapshotToBudget(snap);
  return snap;
}

function paginateFromSnapshot(
  snap: GraphSnapshot,
  filterType: string | undefined,
  limit: number,
  offset: number,
): GraphQueryResult {
  const filteredNodes = filterType
    ? snap.topNodes.filter((n) => n.type === filterType)
    : snap.topNodes;
  const total = filterType
    ? snap.stats.nodesByType[filterType] ?? 0
    : snap.stats.totalNodes;
  const pageNodes = filteredNodes.slice(offset, offset + limit);
  const pageIds = new Set(pageNodes.map((n) => n.id));
  const pageEdges = snap.topEdges.filter(
    (e) => pageIds.has(e.sourceNodeId) && pageIds.has(e.targetNodeId),
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth: 0,
    totalNodes: total,
    totalEdges: snap.stats.totalEdges,
    truncated: total > pageNodes.length,
    limit,
    offset,
    fromSnapshot: true,
  };
}

// #814 v2: no caller can survive a kv.list whose payload is too big to
// JSON.parse without starving the iii heartbeat, and the response frame
// is rejected at its length header before any node-side code can bound
// it. We can't know the corpus size without enumerating, but the
// snapshot's recorded `totalNodes` is a proxy we can read cheaply.
// Operators above the threshold should use mem::graph-reset and let
// future extracts rebuild incrementally.
const SAFE_ENUMERATION_NODE_CEILING = 25000;

const GRAPH_LIST_FRAME_CAP_BYTES = 104_857_600;
const SAFE_ENUMERATION_FRAME_FRACTION = 0.5;
const SAFE_ENUMERATION_BYTE_BUDGET =
  GRAPH_LIST_FRAME_CAP_BYTES * SAFE_ENUMERATION_FRAME_FRACTION;
// Bounded sample: mean row size over the first N rows, not over the whole
// corpus, so measuring the corpus never costs a pass over the corpus.
const ROW_BYTE_SAMPLE = 200;
const CALIBRATED_BYTES_PER_NODE = 4481;
const CALIBRATED_BYTES_PER_EDGE = 3036;

type GraphEnumerationCheck = {
  enumerable: boolean;
  totalNodes: number | null;
  totalEdges: number | null;
  orphaned: boolean;
  ceiling: number;
  nodeBytes: number | null;
  edgeBytes: number | null;
  byteBudget: number;
  blockedScope: string | null;
};

function hasOrphanRows(snap: GraphSnapshot): boolean {
  return typeof snap.resetAt === "string" && Date.parse(snap.resetAt) > 0;
}

// The per-row size comes from the snapshot's recorded measurement of a STORED
// row, never from topNodes / topEdges. Those became provenance-free projections
// in U1, so sampling them reads a ~250-byte row where the scope holds a ~28 KB
// one, and the guard would wave through the enumeration it exists to refuse.
function estimateScopeBytes(
  total: number | null,
  measuredPerRow: number | undefined,
  calibratedFloor: number,
): number | null {
  if (total === null || !Number.isFinite(total) || total < 0) return null;
  const perRow = Math.max(measuredPerRow ?? 0, calibratedFloor);
  return total * perRow;
}

// The snapshot's count only covers rows it knows about, so it bounds the
// scope in two cases and neither of them may be assumed. A missing
// snapshot counts nothing at all. A post-reset snapshot counts only rows
// written since the reset, while mem::graph-reset deliberately leaves
// every prior row on disk, so its count can read low against an
// arbitrarily large scope. Both fail closed, as does a zero count.
async function checkGraphEnumerable(
  kv: StateKV,
): Promise<GraphEnumerationCheck> {
  const snap = await readSnapshot(kv);
  const totalNodes = snap ? snap.stats.totalNodes : null;
  const totalEdges = snap ? snap.stats.totalEdges ?? null : null;
  const orphaned = snap ? hasOrphanRows(snap) : false;
  const nodeBytes = estimateScopeBytes(
    totalNodes,
    snap?.stats.nodeRowBytes,
    CALIBRATED_BYTES_PER_NODE,
  );
  const edgeBytes = estimateScopeBytes(
    totalEdges,
    snap?.stats.edgeRowBytes,
    CALIBRATED_BYTES_PER_EDGE,
  );
  const nodesFit =
    nodeBytes !== null && nodeBytes <= SAFE_ENUMERATION_BYTE_BUDGET;
  const edgesFit =
    edgeBytes !== null && edgeBytes <= SAFE_ENUMERATION_BYTE_BUDGET;
  let blockedScope: string | null = null;
  if (snap && totalNodes !== null && totalNodes > 0 && !orphaned) {
    if (!nodesFit) blockedScope = KV.graphNodes;
    else if (!edgesFit) blockedScope = KV.graphEdges;
  }
  return {
    enumerable:
      !orphaned &&
      totalNodes !== null &&
      totalNodes > 0 &&
      totalNodes <= SAFE_ENUMERATION_NODE_CEILING &&
      nodesFit &&
      edgesFit,
    totalNodes,
    totalEdges,
    orphaned,
    ceiling: SAFE_ENUMERATION_NODE_CEILING,
    nodeBytes,
    edgeBytes,
    byteBudget: SAFE_ENUMERATION_BYTE_BUDGET,
    blockedScope,
  };
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function describeCorpusSize(check: GraphEnumerationCheck): string {
  if (check.totalNodes === null) return "no graph snapshot exists";
  if (check.orphaned) {
    return (
      `the snapshot counts ${check.totalNodes} post-reset nodes but ` +
      "mem::graph-reset left an unbounded number of prior rows in the scope"
    );
  }
  if (check.totalNodes === 0) return "the snapshot counts zero nodes";
  if (check.blockedScope !== null) {
    const isNodes = check.blockedScope === KV.graphNodes;
    const bytes = isNodes ? check.nodeBytes : check.edgeBytes;
    const rows = isNodes ? check.totalNodes : check.totalEdges;
    if (bytes === null) {
      return `the snapshot does not count the rows in ${check.blockedScope}`;
    }
    return (
      `${check.blockedScope} holds ${rows} rows, an estimated ` +
      `${mib(bytes)} MiB against a ${mib(check.byteBudget)} MiB ` +
      "per-scope enumeration budget"
    );
  }
  return `the snapshot does not count the rows in ${KV.graphNodes}`;
}

const ENUMERATION_WARN_INTERVAL_MS = 60_000;
const enumerationWarnState = new Map<
  string,
  { lastAt: number; suppressed: number }
>();

function warnEnumerationThrottled(
  key: string,
  msg: string,
  fields: Record<string, unknown>,
): void {
  const now = Date.now();
  const state = enumerationWarnState.get(key) ?? { lastAt: 0, suppressed: 0 };
  const elapsed = now - state.lastAt;
  if (state.lastAt > 0 && elapsed >= 0 && elapsed < ENUMERATION_WARN_INTERVAL_MS) {
    state.suppressed += 1;
    enumerationWarnState.set(key, state);
    return;
  }
  logger.warn(msg, { ...fields, suppressedSinceLastWarning: state.suppressed });
  enumerationWarnState.set(key, { lastAt: now, suppressed: 0 });
}

export async function listGraphScopes(
  kv: StateKV,
  caller: string,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; enumerated: boolean }> {
  const check = await checkGraphEnumerable(kv);
  if (!check.enumerable) {
    warnEnumerationThrottled(
      `refused:${caller}`,
      "Graph scope enumeration refused",
      {
        caller,
        scopes: `${KV.graphNodes}, ${KV.graphEdges}`,
        totalNodes: check.totalNodes,
        totalEdges: check.totalEdges,
        ceiling: check.ceiling,
        blockedScope: check.blockedScope,
        estimatedNodeBytes: check.nodeBytes,
        estimatedEdgeBytes: check.edgeBytes,
        byteBudget: check.byteBudget,
        reason: describeCorpusSize(check),
        remedy:
          'POST /agentmemory/graph/snapshot-rebuild {"force": true} on a ' +
          "corpus known to be small, or POST /agentmemory/graph/reset",
      },
    );
    return { nodes: [], edges: [], enumerated: false };
  }
  let failed = false;
  const onListFailure =
    (scope: string) =>
    (err: unknown): [] => {
      failed = true;
      warnEnumerationThrottled(
        `failed:${scope}`,
        "Graph scope enumeration failed",
        {
          caller,
          scope,
          totalNodes: check.totalNodes,
          ceiling: check.ceiling,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return [];
    };
  const [nodes, edges] = await Promise.all([
    kv.list<GraphNode>(KV.graphNodes).catch(onListFailure(KV.graphNodes)),
    kv.list<GraphEdge>(KV.graphEdges).catch(onListFailure(KV.graphEdges)),
  ]);
  if (failed) return { nodes: [], edges: [], enumerated: false };
  return { nodes, edges, enumerated: true };
}

// R3: what a row looks like once it is cached. Identity, display, and rank
// survive; provenance does not. One helper each so every push site uses the same
// shape -- the two push sites build from full rows, which a reader-only audit of
// snap.topNodes misses.
function snapshotNode(node: GraphNode): GraphSnapshotNode {
  const { sourceObservationIds, sourceBatchIds, ...cached } = node;
  void sourceObservationIds;
  void sourceBatchIds;
  return cached;
}

function snapshotEdge(edge: GraphEdge): GraphSnapshotEdge {
  const { sourceObservationIds, sourceBatchIds, ...cached } = edge;
  void sourceObservationIds;
  void sourceBatchIds;
  return cached;
}

// Mean serialized bytes over a sample of STORED rows, for the enumeration
// guard. Undefined when the sample is empty, which leaves the calibrated floor.
function meanRowBytes(rows: unknown[]): number | undefined {
  if (rows.length === 0) return undefined;
  return Math.round(payloadByteLength(rows) / rows.length);
}

function nameIndexKey(type: string, name: string): string {
  return `${type}|${name}`;
}

function edgeIndexKey(
  sourceNodeId: string,
  targetNodeId: string,
  type: string,
): string {
  return `${sourceNodeId}|${targetNodeId}|${type}`;
}

// Diagnostic (2026-09-05). The engine drops the worker's socket on a frame
// over FRAME_LIMIT_BYTES (frame-guard.ts:1-5), every graph-extract death in
// production sits within seconds of a state::set dispatch, and nothing on
// this write path measures what it hands the SDK. Each write below is sized
// against the exact { scope, key, value } object StateKV.set serializes; the
// wire frame is that plus a ~200-byte invoke envelope. The warn is emitted
// BEFORE the write so its bytes reach the log even when the write never
// returns ("Invocation timeout after 30000ms: state::set"). One line per
// oversized write; the per-call summary is keyed by scope, so its size is
// bounded by the schema's graph scopes, not by the batch.
const GRAPH_WRITE_WARN_BYTES = 8 * 1024 * 1024;

type GraphWriteLedger = {
  writes: number;
  bytes: number;
  ms: number;
  refused: number;
  index: { adj: number; obs: number; names: number; refused: number } | null;
  byScope: Record<
    string,
    {
      writes: number;
      bytes: number;
      maxBytes: number;
      ms: number;
      refused?: number;
    }
  >;
  // Set before each write, cleared when it returns; a write that throws
  // leaves itself here so the summary can name it.
  inFlight: { scope: string; key: string; bytes: number; ms?: number } | null;
  snap: GraphSnapshot | null;
};

function newWriteLedger(): GraphWriteLedger {
  return {
    writes: 0,
    bytes: 0,
    ms: 0,
    refused: 0,
    index: null,
    byScope: {},
    inFlight: null,
    snap: null,
  };
}

// R1: every graph write is sized before it is dispatched, and one over
// SAFE_PAYLOAD_BYTES comes back as a named error instead of going to the SDK.
// The engine closes the socket at the frame header, so an oversized write does
// not fail — it drops the worker and takes the whole extract with it. Refusing
// costs one row; dispatching costs the process.
//
// ponytail: the refusal is defence in depth. The snapshot bound below is what
// keeps writes small; nothing should reach this branch. It returns rather than
// throws because no caller here has a recovery path better than "log and carry
// on with the rest of the batch", and one refused row must not lose the others.
export async function guardedSet<T>(
  kv: StateKV,
  scope: string,
  key: string,
  value: T,
  ledger?: GraphWriteLedger,
  detail?: Record<string, unknown>,
): Promise<T | OversizedPayload> {
  const bytes = payloadByteLength({ scope, key, value });
  if (bytes > GRAPH_WRITE_WARN_BYTES) {
    logger.warn("Graph write over 8 MiB", {
      scope,
      key,
      bytes,
      frameLimitBytes: FRAME_LIMIT_BYTES,
      overFrameLimit: bytes > FRAME_LIMIT_BYTES,
      ...detail,
    });
  }
  const oversized = checkPayloadFrameSize(
    { scope, key, value },
    `refused the ${scope} write for key ${key}`,
  );
  if (oversized) {
    logger.warn("Graph write refused over the frame limit", {
      scope,
      key,
      bytes: oversized.bytes,
      limitBytes: oversized.limitBytes,
    });
    // A refusal is a write that never returned, the same class as the timeout
    // dd59718 was built to keep visible, so it has to reach the ledger. The
    // summary reads snapshotBytes off byScope[...].maxBytes, and a refusal that
    // skipped accounting would report undefined on the one call where the size
    // is the whole story. Counted as refused, not as a write: nothing was sent.
    if (ledger) {
      ledger.inFlight = { scope, key, bytes, ms: 0 };
      const s = (ledger.byScope[scope] ??= {
        writes: 0,
        bytes: 0,
        maxBytes: 0,
        ms: 0,
      });
      s.bytes += bytes;
      if (bytes > s.maxBytes) s.maxBytes = bytes;
      s.refused = (s.refused ?? 0) + 1;
      ledger.bytes += bytes;
      ledger.refused += 1;
    }
    return oversized;
  }
  const started = Date.now();
  if (ledger) ledger.inFlight = { scope, key, bytes };
  try {
    const result = await kv.set(scope, key, value);
    if (ledger) ledger.inFlight = null;
    return result;
  } finally {
    const ms = Date.now() - started;
    if (ledger) {
      if (ledger.inFlight) ledger.inFlight.ms = ms;
      const s = (ledger.byScope[scope] ??= {
        writes: 0,
        bytes: 0,
        maxBytes: 0,
        ms: 0,
      });
      s.writes += 1;
      s.bytes += bytes;
      s.ms += ms;
      if (bytes > s.maxBytes) s.maxBytes = bytes;
      ledger.writes += 1;
      ledger.bytes += bytes;
      ledger.ms += ms;
    }
  }
}

// The GuardedWrite the store's helpers take. Binding it here is what makes
// "every graph write goes through guardedSet" true for the index scopes too,
// without graph-store importing this module back and forming a cycle.
export function graphWriter(kv: StateKV, ledger?: GraphWriteLedger): GuardedWrite {
  return <T>(scope: string, key: string, value: T) =>
    guardedSet(kv, scope, key, value, ledger);
}

// Mutates `snap` to apply a +1 (or -1) degree delta for nodeId,
// maintaining the top-N ranking. Returns the new degree. Reads /
// writes the per-node degree counter via targeted kv.get/set so we
// never enumerate. Top-N membership flips when:
//   - node's new degree > current min in topNodes AND it's not in
//     topNodes (promote, evict tail if topNodes is full)
//   - node IS in topNodes and its position needs resorting (re-sort
//     topNodes in place)
async function applyDegreeDelta(
  kv: StateKV,
  ledger: GraphWriteLedger,
  snap: GraphSnapshot,
  nodeId: string,
  delta: number,
): Promise<number> {
  const prev = (await kv.get<number>(KV.graphNodeDegree, nodeId)) ?? 0;
  const next = Math.max(0, prev + delta);
  await guardedSet(kv, KV.graphNodeDegree, nodeId, next, ledger);

  const inTop = snap.topNodes.findIndex((n) => n.id === nodeId);
  if (inTop !== -1) {
    // Cache the new degree in topDegrees so the comparator runs
    // synchronously over numbers, not async kv.get calls. Re-sort
    // descending by degree.
    snap.topDegrees[nodeId] = next;
    snap.topNodes.sort(
      (a, b) =>
        (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
    );
    return next;
  }

  if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
    // Capacity available — fetch + promote.
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      snap.topNodes.push(snapshotNode(node));
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
    return next;
  }

  // topNodes is full; the cutoff is the tail's cached degree.
  const tailEntry = snap.topNodes[snap.topNodes.length - 1];
  if (!tailEntry) return next;
  const tailDegree = snap.topDegrees[tailEntry.id] ?? 0;
  if (next > tailDegree) {
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      const evicted = snap.topNodes.pop();
      if (evicted) delete snap.topDegrees[evicted.id];
      snap.topNodes.push(snapshotNode(node));
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
  }
  return next;
}

function snapshotPushEdgeIfBothInTop(
  snap: GraphSnapshot,
  edge: GraphEdge,
): void {
  const topIds = new Set(snap.topNodes.map((n) => n.id));
  if (topIds.has(edge.sourceNodeId) && topIds.has(edge.targetNodeId)) {
    // Dedupe in case the same edge gets pushed twice.
    if (snap.topEdges.find((e) => e.id === edge.id)) return;
    if (snap.topEdges.length >= SNAPSHOT_TOP_EDGES) {
      // Evict the lowest-weight edge, but only if the incoming one beats it;
      // otherwise the cap holds and the new edge simply is not cached.
      let minIdx = 0;
      for (let i = 1; i < snap.topEdges.length; i++) {
        if (snap.topEdges[i]!.weight < snap.topEdges[minIdx]!.weight) minIdx = i;
      }
      if (snap.topEdges[minIdx]!.weight >= edge.weight) return;
      snap.topEdges.splice(minIdx, 1);
    }
    snap.topEdges.push(snapshotEdge(edge));
  }
}

// In legacy mode a merge unions the whole batch's observation ids into the row
// and the arrays grow forever. In batch mode a merge unions one batch id
// instead and leaves the inline array as it was, so a row that was written in
// legacy mode keeps its legacy ids and merely gains a batch id on top -- both
// shapes stay resolvable and nothing is rewritten.
function unionIds(...lists: Array<string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []))];
}

// KTD2's ceiling. Keeps the most recent GRAPH_ROW_BATCH_CAP ids by dropping from
// the front, which is oldest-first because unionIds preserves append order. The
// survivors keep their relative order, which graph-provenance.ts:12-14 makes
// part of the contract: retrieval scores by first-seen.
//
// The accepted regression, stated in KTD2 rather than discovered later: a row
// touched by more than the cap resolves only its most recent batches through
// graph-retrieval.ts, which uses that direction to dedupe and label rather than
// for correctness. Cascade is exact regardless, because U3 made it read
// mem:graph:obs-index instead of the row -- which is why KTD5 required U3 to
// land before this cap, and it has.
//
// graph-store.ts caps mem:graph:obs-index the same way, with its own constant.
function capBatchIds(ids: string[]): string[] {
  const cap = getGraphRowBatchCap();
  return ids.length > cap ? ids.slice(ids.length - cap) : ids;
}

function mergeNode(
  existing: GraphNode,
  incoming: GraphNode,
  obsIds: string[],
  batchId: string | null,
  capturedAt: string,
): GraphNode {
  const merged: GraphNode = {
    ...existing,
    properties: { ...existing.properties, ...incoming.properties },
    updatedAt: capturedAt,
  };
  if (batchId) {
    merged.sourceBatchIds = capBatchIds(
      unionIds(existing.sourceBatchIds, [batchId]),
    );
  } else {
    merged.sourceObservationIds = unionIds(
      existing.sourceObservationIds,
      incoming.sourceObservationIds,
      obsIds,
    );
  }
  return merged;
}

function mergeEdge(
  existing: GraphEdge,
  obsIds: string[],
  batchId: string | null,
): GraphEdge {
  const merged: GraphEdge = { ...existing };
  if (batchId) {
    merged.sourceBatchIds = capBatchIds(
      unionIds(existing.sourceBatchIds, [batchId]),
    );
  } else {
    merged.sourceObservationIds = unionIds(existing.sourceObservationIds, obsIds);
  }
  return merged;
}

function resolvePagination(
  rawLimit: number | undefined,
  rawOffset: number | undefined,
): { limit: number; offset: number } {
  const requested = typeof rawLimit === "number" && Number.isFinite(rawLimit)
    ? Math.floor(rawLimit)
    : DEFAULT_GRAPH_QUERY_LIMIT;
  const limit = Math.max(1, Math.min(requested, MAX_GRAPH_QUERY_LIMIT));
  const offset = Math.max(
    0,
    typeof rawOffset === "number" && Number.isFinite(rawOffset)
      ? Math.floor(rawOffset)
      : 0,
  );
  return { limit, offset };
}

function paginate(
  nodes: GraphNode[],
  allEdges: GraphEdge[],
  depth: number,
  limit: number,
  offset: number,
): GraphQueryResult {
  const totalNodes = nodes.length;
  const pageNodes = nodes.slice(offset, offset + limit);
  const pageNodeIds = new Set(pageNodes.map((n) => n.id));
  // Edges restricted to the page so the response payload scales with
  // `limit`, not with the global edge count. An edge is included only
  // when BOTH endpoints land in the page — half-edges to nodes outside
  // the page would render as dangling links in the viewer.
  const pageEdges = allEdges.filter(
    (e) => pageNodeIds.has(e.sourceNodeId) && pageNodeIds.has(e.targetNodeId),
  );
  // Total edges (for the same node universe). Counted unbounded so the
  // viewer can show "showing X of Y" without re-querying.
  const universeIds = new Set(nodes.map((n) => n.id));
  const totalEdges = allEdges.reduce(
    (count, e) =>
      universeIds.has(e.sourceNodeId) && universeIds.has(e.targetNodeId)
        ? count + 1
        : count,
    0,
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth,
    totalNodes,
    totalEdges,
    truncated: totalNodes > pageNodes.length,
    limit,
    offset,
  };
}

// Parse all key="value" pairs from a tag's attribute string, in any
// order. The previous parser hard-coded attribute order
// (type before name on <entity>, type/source/target/weight on
// <relationship>) and silently dropped nodes/edges when the upstream
// LLM emitted attributes in a different order — Codex in particular
// likes to lead with `name=` (#635).
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

// LLM-extracted rows carry the whole batch's provenance because the model
// answers for the batch as a unit, not per observation. With a batch id that is
// one small array instead of N ids copied onto every row.
function parseGraphXml(
  xml: string,
  observationIds: string[],
  batchId: string | null,
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();
  const provenance = batchId
    ? { sourceObservationIds: [] as string[], sourceBatchIds: [batchId] }
    : { sourceObservationIds: observationIds };

  // Two passes because <entity> can be self-closing or have a body
  // (<property> children). The self-closing form needs `[^>]*[^/]` on
  // the attr group so the trailing `/` isn't swallowed into the match
  // (root cause of #494). The explicit-close form picks up the
  // property block.
  const entitySelfClose = /<entity\b([^>]*?)\/>/g;
  const entityWithBody = /<entity\b([^>]*[^/])>([\s\S]*?)<\/entity>/g;

  const addEntity = (rawAttrs: string, propsBlock = ""): void => {
    const attrs = parseAttrs(rawAttrs);
    const type = attrs["type"] as GraphNode["type"] | undefined;
    const name = attrs["name"];
    if (!type || !name) return;
    const properties: Record<string, string> = {};
    const propRegex = /<property\s+key="([^"]+)">([^<]*)<\/property>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(propsBlock)) !== null) {
      properties[propMatch[1]] = propMatch[2];
    }
    nodes.push({
      id: generateId("gn"),
      type,
      name,
      properties,
      ...provenance,
      createdAt: now,
    });
  };

  let match;
  while ((match = entitySelfClose.exec(xml)) !== null) {
    addEntity(match[1]);
  }
  while ((match = entityWithBody.exec(xml)) !== null) {
    addEntity(match[1], match[2]);
  }

  const relRegex = /<relationship\b([^>]*?)\/>/g;
  while ((match = relRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    const type = attrs["type"] as GraphEdge["type"] | undefined;
    const sourceName = attrs["source"];
    const targetName = attrs["target"];
    if (!type || !sourceName || !targetName) continue;
    const parsedWeight = parseFloat(attrs["weight"] ?? "");
    const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0.5;

    const sourceNode = nodes.find((n) => n.name === sourceName);
    const targetNode = nodes.find((n) => n.name === targetName);
    if (!sourceNode || !targetNode) continue;
    edges.push({
      id: generateId("ge"),
      type,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      weight: Math.max(0, Math.min(1, weight)),
      ...provenance,
      createdAt: now,
    });
  }

  return { nodes, edges };
}

const HEURISTIC_EDGE_WEIGHT = 0.4;
const MAX_HEURISTIC_EDGES_PER_OBS = 12;

export function extractGraphHeuristics(
  observations: CompressedObservation[],
  // Batch mode stamps a heuristic row the same way it stamps an LLM one: one
  // batch id instead of the observation ids inline. Optional and defaulted so
  // every direct caller keeps the legacy shape it asserts on.
  batchId: string | null = null,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const now = new Date().toISOString();
  const nodes: GraphNode[] = [];
  const nodeByKey = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeByPair = new Map<string, GraphEdge>();

  const nodeFor = (
    type: GraphNode["type"],
    name: string,
    obsId: string,
  ): GraphNode | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const key = `${type} ${trimmed.toLowerCase()}`;
    let node = nodeByKey.get(key);
    if (!node) {
      node = {
        id: generateId("gn"),
        type,
        name: trimmed,
        properties: {},
        ...(batchId
          ? { sourceObservationIds: [] as string[], sourceBatchIds: [batchId] }
          : { sourceObservationIds: [obsId] }),
        createdAt: now,
      };
      nodeByKey.set(key, node);
      nodes.push(node);
    } else if (!batchId && !node.sourceObservationIds.includes(obsId)) {
      node.sourceObservationIds.push(obsId);
    }
    return node;
  };

  for (const obs of observations) {
    let budget = MAX_HEURISTIC_EDGES_PER_OBS;
    const link = (a: GraphNode | null, b: GraphNode | null): void => {
      if (!a || !b || a.id === b.id) return;
      const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const existing = edgeByPair.get(pair);
      if (existing) {
        if (!batchId && !existing.sourceObservationIds.includes(obs.id)) {
          existing.sourceObservationIds.push(obs.id);
        }
        return;
      }
      if (budget <= 0) return;
      budget -= 1;
      const edge: GraphEdge = {
        id: generateId("ge"),
        type: "related_to",
        sourceNodeId: a.id,
        targetNodeId: b.id,
        weight: HEURISTIC_EDGE_WEIGHT,
        ...(batchId
          ? { sourceObservationIds: [] as string[], sourceBatchIds: [batchId] }
          : { sourceObservationIds: [obs.id] }),
        createdAt: now,
      };
      edgeByPair.set(pair, edge);
      edges.push(edge);
    };

    const fileNodes = (obs.files ?? []).map((f) =>
      nodeFor("file", f, obs.id),
    );
    const conceptNodes = (obs.concepts ?? []).map((c) =>
      nodeFor("concept", c, obs.id),
    );

    for (const concept of conceptNodes) {
      for (const file of fileNodes) link(concept, file);
    }
    for (let i = 0; i + 1 < conceptNodes.length; i++) {
      link(conceptNodes[i], conceptNodes[i + 1]);
    }
    for (let i = 0; i + 1 < fileNodes.length; i++) {
      link(fileNodes[i], fileNodes[i + 1]);
    }
  }

  return { nodes, edges };
}

// Shared persistence for a batch of extracted/imported nodes and edges.
// Factored out of mem::graph-extract so structural importers (graphify)
// reuse the exact same name-index upsert, degree bookkeeping, and snapshot
// maintenance — which also makes re-imports idempotent: an existing
// (type, name) resolves through the name index and merges instead of
// duplicating.
//
// #814 v2: targeted name-index lookups replace the O(n) scan over
// `kv.list<GraphNode>(KV.graphNodes)`. At 75K nodes the list payload
// exceeds the iii heartbeat budget and the worker dies before merge can
// complete. Each name-index entry is a single small kv.get/set pair.
async function persistGraphDeltaMeasured(
  kv: StateKV,
  ledger: GraphWriteLedger,
  nodes: GraphNode[],
  edges: GraphEdge[],
  obsIds: string[],
  // Null means legacy provenance: merges union observation ids as they always
  // have. A batch id means merges union that id instead.
  batchId: string | null,
): Promise<{ newNodeCount: number; newEdgeCount: number }> {
  // readSnapshot() collapses two different situations into null: "no
  // snapshot yet" and "the read failed" (it catches and logs). Bootstrapping
  // an unmarked empty snapshot from the SECOND case is what let a 414 MB
  // graph scope look enumerable in production:
  //
  //   worker dies -> readSnapshot fails -> null -> bootstrap empty snapshot
  //   with no resetAt -> the kv.set below overwrites the real snapshot, so
  //   rows already on disk are invisible AND unmarked -> checkGraphEnumerable
  //   sees a tiny totalNodes with no orphan flag -> GraphRetrieval enumerates
  //   the whole scope -> frame past the ws 100 MiB maxPayload -> RangeError,
  //   close 1009 -> worker dies -> repeat.
  //
  // Read it here directly so the two cases stay distinguishable. A FAILED
  // read stamps resetAt (what mem::graph-reset does) so hasOrphanRows keeps
  // enumeration closed until a rebuild re-counts. A genuinely ABSENT
  // snapshot is a cold start with nothing on disk, so it stays unmarked and
  // graph-query BFS keeps working.
  let existingSnap: GraphSnapshot | null = null;
  let snapshotReadFailed = false;
  try {
    const raw = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    if (raw && typeof raw === "object" && raw.version === 1) existingSnap = raw;
  } catch (err) {
    snapshotReadFailed = true;
    logger.warn("Graph snapshot read failed, bootstrapping as orphaned", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const snap =
    existingSnap ??
    (snapshotReadFailed
      ? { ...emptySnapshot(), resetAt: new Date().toISOString() }
      : emptySnapshot());
  // persistGraphDelta deliberately reads raw above, to keep "absent" and "read
  // failed" distinguishable, so readSnapshot's truncation does not reach it.
  truncateTopEdges(snap);
  ledger.snap = snap;
  // U3. Index writes are collected across the whole call and flushed once, so a
  // batch that hangs 36 edges off a handful of hubs does one write per distinct
  // key instead of two per edge, and the 64-stub cap sees the whole batch before
  // it evicts anything.
  const indexDelta: GraphIndexDelta = newIndexDelta();
  const capturedAt = new Date().toISOString();
  let newNodeCount = 0;
  let newEdgeCount = 0;
  // Merge-only batches mutate cached topNodes/topEdges entries without
  // changing the counts; track that separately so the snapshot still persists.
  let snapMutated = false;
  const newEdgesForTopCheck: GraphEdge[] = [];
  // When a freshly-minted node merges into an existing row via the name
  // index, edges in the same batch still reference the fresh id. Remap edge
  // endpoints to the persisted ids so edges never dangle and re-runs hit the
  // same edge-index key instead of duplicating.
  const idRemap = new Map<string, string>();

  for (const node of nodes) {
    const indexKey = nameIndexKey(node.type, node.name);
    const existingId = await kv.get<string>(KV.graphNameIndex, indexKey);

    let existing: GraphNode | null = null;
    if (existingId) {
      existing = await kv.get<GraphNode>(KV.graphNodes, existingId);
      // #825 follow-up: name-index lookups can resolve into
      // pre-reset rows. Drop them so extract writes a fresh
      // node + index entry instead of silently reconnecting
      // to a legacy orphan (which would keep the snapshot at
      // 0 forever after a reset).
      if (
        existing &&
        snap.resetAt &&
        typeof existing.createdAt === "string" &&
        existing.createdAt < snap.resetAt
      ) {
        existing = null;
      }
    }

    if (existing) {
      idRemap.set(node.id, existing.id);
      const merged = mergeNode(existing, node, obsIds, batchId, capturedAt);
      await guardedSet(kv, KV.graphNodes, existing.id, merged, ledger);
      // The catalog entry is already there: name is identity, so a merge never
      // changes it. Only the observation link is new.
      recordRowObservations(indexDelta, obsIds, existing.id, "node");
      // Update topNodes entry if present so a stale clone isn't
      // returned from the snapshot fast path.
      const topIdx = snap.topNodes.findIndex((n) => n.id === existing!.id);
      if (topIdx !== -1) {
        snap.topNodes[topIdx] = snapshotNode(merged);
        snapMutated = true;
      }
    } else {
      await guardedSet(kv, KV.graphNodes, node.id, node, ledger);
      await guardedSet(kv, KV.graphNameIndex, indexKey, node.id, ledger);
      await guardedSet(kv, KV.graphNodeDegree, node.id, 0, ledger);
      recordNodeName(indexDelta, node);
      recordRowObservations(indexDelta, obsIds, node.id, "node");
      snap.stats.totalNodes += 1;
      snap.stats.nodesByType[node.type] =
        (snap.stats.nodesByType[node.type] ?? 0) + 1;
      newNodeCount += 1;
      if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
        // Degree 0 still beats an empty slot — sit at the tail
        // until edges arrive and promote.
        snap.topNodes.push(snapshotNode(node));
        snap.topDegrees[node.id] = 0;
      }
    }
  }

  for (const rawEdge of edges) {
    const edge: GraphEdge = {
      ...rawEdge,
      sourceNodeId: idRemap.get(rawEdge.sourceNodeId) ?? rawEdge.sourceNodeId,
      targetNodeId: idRemap.get(rawEdge.targetNodeId) ?? rawEdge.targetNodeId,
    };
    const eKey = edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type);
    const existingId = await kv.get<string>(KV.graphEdgeKey, eKey);

    let existing: GraphEdge | null = null;
    if (existingId) {
      existing = await kv.get<GraphEdge>(KV.graphEdges, existingId);
      // Same #825 orphan check as the node path above.
      if (
        existing &&
        snap.resetAt &&
        typeof existing.createdAt === "string" &&
        existing.createdAt < snap.resetAt
      ) {
        existing = null;
      }
    }

    if (existing) {
      const merged = mergeEdge(existing, obsIds, batchId);
      await guardedSet(kv, KV.graphEdges, existing.id, merged, ledger);
      // mergeEdge unions provenance and never weight or endpoints, so the
      // adjacency stub written when this edge was created still holds.
      recordRowObservations(indexDelta, obsIds, existing.id, "edge");
      // Replace cached topEdges entry too if present.
      const topIdx = snap.topEdges.findIndex((e) => e.id === existing!.id);
      if (topIdx !== -1) {
        snap.topEdges[topIdx] = snapshotEdge(merged);
        snapMutated = true;
      }
    } else {
      await guardedSet(kv, KV.graphEdges, edge.id, edge, ledger);
      await guardedSet(kv, KV.graphEdgeKey, eKey, edge.id, ledger);
      recordEdgeAdjacency(indexDelta, edge);
      recordRowObservations(indexDelta, obsIds, edge.id, "edge");
      snap.stats.totalEdges += 1;
      snap.stats.edgesByType[edge.type] =
        (snap.stats.edgesByType[edge.type] ?? 0) + 1;
      newEdgeCount += 1;
      await applyDegreeDelta(kv, ledger, snap, edge.sourceNodeId, +1);
      await applyDegreeDelta(kv, ledger, snap, edge.targetNodeId, +1);
      newEdgesForTopCheck.push(edge);
    }
  }

  // Push newly-added edges into snapshot.topEdges if both
  // endpoints are in the top-N (post-degree-delta). Done after
  // all degree updates so the topIds set is stable.
  for (const edge of newEdgesForTopCheck) {
    snapshotPushEdgeIfBothInTop(snap, edge);
  }

  // Flushed before the snapshot write. The snapshot write is the one that has
  // historically timed out, and an index that landed is worth more than one that
  // was lost behind it.
  ledger.index = await flushIndexDelta(kv, indexDelta, graphWriter(kv, ledger));

  if (newNodeCount > 0 || newEdgeCount > 0 || snapMutated) {
    snap.updatedAt = capturedAt;
    snap.dirty = false;
    // Free: the ledger already sized every row this call wrote. It samples only
    // the rows THIS batch touched, though, and a new-node-heavy batch writes
    // thin rows while the scope still holds fat legacy ones -- so the mean can
    // read low against the corpus. Keep it a monotonic upper bound here.
    // Over-restrictive is the safe direction for a fail-closed guard, and
    // buildSnapshotFromArrays ratchets it back down from a representative
    // sample when a rebuild recomputes the corpus for real.
    const nodeScope = ledger.byScope[KV.graphNodes];
    if (nodeScope && nodeScope.writes > 0) {
      snap.stats.nodeRowBytes = Math.max(
        snap.stats.nodeRowBytes ?? 0,
        Math.round(nodeScope.bytes / nodeScope.writes),
      );
    }
    const edgeScope = ledger.byScope[KV.graphEdges];
    if (edgeScope && edgeScope.writes > 0) {
      snap.stats.edgeRowBytes = Math.max(
        snap.stats.edgeRowBytes ?? 0,
        Math.round(edgeScope.bytes / edgeScope.writes),
      );
    }
    shrinkSnapshotToBudget(snap);
    await guardedSet(kv, KV.graphSnapshot, SNAPSHOT_KEY, snap, ledger, {
      topNodes: snap.topNodes.length,
      topEdges: snap.topEdges.length,
    });
  }

  return { newNodeCount, newEdgeCount };
}

// Diagnostic wrapper (see guardedSet). One summary line per call, emitted
// from finally so a write that times out still reports what it was carrying.
export async function persistGraphDelta(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  obsIds: string[],
  batchId: string | null = null,
): Promise<{ newNodeCount: number; newEdgeCount: number }> {
  const ledger = newWriteLedger();
  const started = Date.now();
  let result: { newNodeCount: number; newEdgeCount: number } | undefined;
  let error: string | undefined;
  try {
    result = await persistGraphDeltaMeasured(
      kv,
      ledger,
      nodes,
      edges,
      obsIds,
      batchId,
    );
    return result;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    logger.info("Graph delta persisted", {
      nodes: nodes.length,
      edges: edges.length,
      newNodes: result?.newNodeCount,
      newEdges: result?.newEdgeCount,
      topNodes: ledger.snap?.topNodes.length,
      topEdges: ledger.snap?.topEdges.length,
      // Which lineage this snapshot is: the 09-01 19:04Z failed-read
      // bootstrap stamped resetAt, and totalNodes is what the last write
      // that fit under the frame persisted, not what is on disk.
      snapshotResetAt: ledger.snap?.resetAt,
      snapshotTotalNodes: ledger.snap?.stats.totalNodes,
      snapshotBytes: ledger.byScope[KV.graphSnapshot]?.maxBytes,
      writes: ledger.writes,
      refused: ledger.refused,
      index: ledger.index,
      bytes: ledger.bytes,
      writeMs: ledger.ms,
      ms: Date.now() - started,
      byScope: ledger.byScope,
      ...(ledger.inFlight ? { failed: ledger.inFlight } : {}),
      ...(error ? { error } : {}),
    });
  }
}

export function registerGraphFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::graph-extract",
    async (data: { observations: CompressedObservation[] }) => {
      if (!isGraphWriteEnabled()) {
        return { success: true, skipped: true, reason: "GRAPH_WRITES_ENABLED is not set" };
      }

      if (!data.observations || data.observations.length === 0) {
        return { success: false, error: "No observations provided" };
      }

      const obsIds = data.observations.map((o) => o.id);

      // Heuristic rows keep per-observation ids: those are precise and already
      // linear. Only the LLM path stamps the whole batch, so only it batches.
      // Read per call so a flag flip takes effect without a redeploy (KTD6).
      // No longer gated on llmEnabled: heuristic extraction runs regardless of
      // GRAPH_EXTRACTION_ENABLED, and that coupling is why the census found
      // sourceBatchIds empty on all 424,339 production records while the batch
      // machinery sat wired end to end.
      const batchMode = getGraphProvenanceMode() === "batch";
      // Minted here because both extractors stamp rows with it. The row itself
      // is written just before persist, so an extract that produces nothing
      // leaves no orphan batch behind. The invariant is unchanged: the row
      // lands before anything referencing it is persisted.
      const batchId = batchMode ? generateId("gb") : null;

      let nodes: GraphNode[] = [];
      let edges: GraphEdge[] = [];
      try {
        const heuristic = extractGraphHeuristics(data.observations, batchId);
        nodes = heuristic.nodes;
        edges = heuristic.edges;
      } catch (err) {
        logger.warn("heuristic graph extraction failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const llmEnabled =
        isGraphExtractionEnabled() && !provider.name.includes("noop");
      let llmError: string | undefined;
      if (llmEnabled) {
        const prompt = buildGraphExtractionPrompt(
          data.observations.map((o) => ({
            title: o.title,
            narrative: o.narrative,
            concepts: o.concepts,
            files: o.files,
            type: o.type,
          })),
        );
        try {
          const response = await provider.compress(
            GRAPH_EXTRACTION_SYSTEM,
            prompt,
          );
          const parsed = parseGraphXml(response, obsIds, batchId);
          nodes = nodes.concat(parsed.nodes);
          edges = edges.concat(parsed.edges);
        } catch (err) {
          llmError = err instanceof Error ? err.message : String(err);
          logger.error("LLM graph extraction failed", { error: llmError });
        }
      }

      if (nodes.length === 0 && edges.length === 0) {
        return llmError
          ? { success: false, error: llmError }
          : { success: true, nodesAdded: 0, edgesAdded: 0 };
      }

      // Only now, with rows to persist. A reader never resolves a batch id
      // that has no row behind it, because this lands before persistGraphDelta
      // writes the first row carrying it.
      if (batchId) {
        const batch: GraphBatch = {
          id: batchId,
          observationIds: obsIds,
          createdAt: new Date().toISOString(),
        };
        await guardedSet(kv, KV.graphBatches, batch.id, batch);
      }

      try {
        const { newNodeCount, newEdgeCount } = await persistGraphDelta(
          kv,
          nodes,
          edges,
          obsIds,
          batchId,
        );

        await recordAudit(kv, "observe", "mem::graph-extract", obsIds, {
          nodesExtracted: nodes.length,
          edgesExtracted: edges.length,
        });

        logger.info("Graph extraction complete", {
          nodes: nodes.length,
          edges: edges.length,
          newNodes: newNodeCount,
          newEdges: newEdgeCount,
          llm: llmEnabled && !llmError,
        });
        return {
          success: true,
          nodesAdded: nodes.length,
          edgesAdded: edges.length,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Graph extraction failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );

  // #753: every branch now applies a default cap and reports the
  // unbounded `total*` counts. Before this change, an unfiltered POST
  // /graph/query body (`{}`) on a corpus with ~10k+ nodes serialized
  // to a payload large enough that the iii state response channel
  // rejected it with HTTP 500 "Invocation stopped", leaving the viewer
  // graph tab silently blank.
  sdk.registerFunction("mem::graph-query",
    async (data: {
      startNodeId?: string;
      nodeType?: string;
      maxDepth?: number;
      query?: string;
      limit?: number;
      offset?: number;
    }): Promise<GraphQueryResult> => {
      const maxDepth = Math.min(data.maxDepth || 3, 5);
      const { limit, offset } = resolvePagination(data.limit, data.offset);

      // #814 v2: the empty-body / nodeType-only path NEVER enumerates.
      // It reads the snapshot exclusively. The snapshot is updated
      // inline by graph-extract, so for newly-built corpora it's
      // always current. For legacy corpora missing a snapshot the
      // operator must run mem::graph-snapshot-rebuild (safe under
      // SAFE_ENUMERATION_NODE_CEILING) or mem::graph-reset to wipe and
      // rebuild incrementally from new observations.
      const noWalk = !data.query && !data.startNodeId;
      if (noWalk) {
        const snap = await readSnapshot(kv);
        if (snap && snap.stats.totalNodes > 0) {
          return paginateFromSnapshot(snap, data.nodeType, limit, offset);
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "No graph snapshot available. Either no graph has been " +
            "extracted yet, or you are on a legacy corpus from a pre-#814 " +
            "agentmemory build. Run POST /agentmemory/graph/snapshot-rebuild " +
            "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to " +
            "wipe and let future extracts repopulate.",
        };
      }

      const degradeToSnapshot = async (
        warning: string,
      ): Promise<GraphQueryResult> => {
        const snap = await readSnapshot(kv);
        if (snap) {
          return {
            ...paginateFromSnapshot(snap, data.nodeType, limit, offset),
            warning,
          };
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning,
        };
      };

      // The wall-clock budget below cannot save a corpus whose response
      // frame is over the transport ceiling: the frame is rejected at
      // its length header and the worker dies before any timer fires.
      // Refuse the enumeration outright unless the snapshot vouches for
      // the size.
      const enumeration = await checkGraphEnumerable(kv);
      if (!enumeration.enumerable) {
        logger.warn("Graph query enumeration refused, using snapshot", {
          totalNodes: enumeration.totalNodes,
          totalEdges: enumeration.totalEdges,
          ceiling: enumeration.ceiling,
          blockedScope: enumeration.blockedScope,
          estimatedNodeBytes: enumeration.nodeBytes,
          estimatedEdgeBytes: enumeration.edgeBytes,
          byteBudget: enumeration.byteBudget,
        });
        return degradeToSnapshot(
          `Live graph enumeration refused: ${describeCorpusSize(enumeration)}. ` +
            "Query / startNodeId paths degrade to the top-degree snapshot " +
            "until a per-node edge index lands. Result does not reflect the " +
            "requested walk.",
        );
      }

      // Query / startNodeId paths still need broader access. Race the
      // live enumeration against a wall-clock budget so a long
      // kv.list doesn't block the worker indefinitely. On timeout the
      // caller gets a snapshot-backed approximation instead of a 500.
      let allNodes: GraphNode[];
      let allEdges: GraphEdge[];
      try {
        const [rawNodes, rawEdges] = await withTimeout(
          Promise.all([
            kv.list<GraphNode>(KV.graphNodes),
            kv.list<GraphEdge>(KV.graphEdges),
          ]),
          LIVE_ENUMERATION_BUDGET_MS,
          "graph-query enumeration",
        );
        allNodes = rawNodes.filter((n) => !n.stale);
        allEdges = rawEdges.filter((e) => !e.stale);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph query enumeration timed out, using snapshot", {
          error: msg,
        });
        return degradeToSnapshot(
          "Live graph enumeration exceeded budget. Query / " +
            "startNodeId paths degrade on >25K-node corpora until a " +
            "per-node edge index lands. Result reflects top-degree " +
            "snapshot, not the requested walk.",
        );
      }

      if (data.query) {
        const lower = data.query.toLowerCase();
        const matchingNodes = allNodes.filter(
          (n) =>
            n.name.toLowerCase().includes(lower) ||
            Object.values(n.properties).some(
              (v) => typeof v === "string" && v.toLowerCase().includes(lower),
            ),
        );
        return paginate(matchingNodes, allEdges, 0, limit, offset);
      }

      if (data.startNodeId) {
        const visited = new Set<string>();
        const visitedEdges = new Set<string>();
        const resultNodes: GraphNode[] = [];
        const resultEdges: GraphEdge[] = [];
        const queue: Array<{ nodeId: string; depth: number }> = [
          { nodeId: data.startNodeId, depth: 0 },
        ];

        while (queue.length > 0) {
          const { nodeId, depth } = queue.shift()!;
          if (visited.has(nodeId) || depth > maxDepth) continue;
          visited.add(nodeId);

          const node = allNodes.find((n) => n.id === nodeId);
          if (node) {
            if (!data.nodeType || node.type === data.nodeType) {
              resultNodes.push(node);
            }
          }

          const neighborEdges = allEdges.filter(
            (e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId,
          );
          for (const edge of neighborEdges) {
            if (!visitedEdges.has(edge.id)) {
              visitedEdges.add(edge.id);
              resultEdges.push(edge);
            }
            const nextId =
              edge.sourceNodeId === nodeId
                ? edge.targetNodeId
                : edge.sourceNodeId;
            if (!visited.has(nextId)) {
              queue.push({ nodeId: nextId, depth: depth + 1 });
            }
          }
        }

        return paginate(resultNodes, resultEdges, maxDepth, limit, offset);
      }

      // Unreachable — noWalk branch handles the rest.
      return paginate([], [], 0, limit, offset);
    },
  );

  // #814 v2: graph-stats reads the snapshot exclusively. The snapshot
  // is maintained inline by mem::graph-extract, so for any corpus built
  // on a post-#814 agentmemory the stats are always current without an
  // enumeration. Legacy corpora without a snapshot get an empty
  // envelope + a warning pointing at the snapshot-rebuild or graph-reset
  // endpoints — never a 500.
  sdk.registerFunction("mem::graph-stats", async () => {
    const snap = await readSnapshot(kv);
    if (snap) {
      // Named rather than spread: stats now also carries nodeRowBytes and
      // edgeRowBytes, which size the enumeration guard and are nobody's
      // business at the API boundary.
      return {
        totalNodes: snap.stats.totalNodes,
        totalEdges: snap.stats.totalEdges,
        nodesByType: snap.stats.nodesByType,
        edgesByType: snap.stats.edgesByType,
        fromSnapshot: true,
        updatedAt: snap.updatedAt,
        ...(snap.dirty
          ? {
              warning:
                "Snapshot is marked dirty (write was in-flight when read). " +
                "Counts are eventually consistent.",
            }
          : {}),
      };
    }
    return {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
      fromSnapshot: false,
      warning:
        "No graph snapshot available. Run POST /agentmemory/graph/snapshot-rebuild " +
        "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to wipe " +
        "and let future extracts repopulate.",
    };
  });

  // #814 v2: explicit rebuild backfills the snapshot AND the name /
  // edge-key / degree indexes from existing graphNodes/graphEdges
  // scopes. This is the path operators run once after upgrading to a
  // post-#814 build to bring legacy corpora online. It enumerates via
  // kv.list — the same pair that breaks at 75K+ — so we refuse to
  // run on corpora large enough that the response payload would
  // block the worker heartbeat. Above the ceiling the only safe path
  // is mem::graph-reset followed by incremental re-extraction.
  sdk.registerFunction(
    "mem::graph-snapshot-rebuild",
    async (data?: { force?: boolean }) => {
      const started = Date.now();
      // #825: pre-flight refusal for legacy corpora. The old guard
      // checked node count AFTER kv.list, but the heartbeat dies at
      // ~0.35s on a 75K-node response — long before the wall-clock
      // budget can fire. We can't safely enumerate to discover size.
      //
      // Heuristic: if no snapshot exists, the corpus is either empty
      // or legacy. The empty case has nothing to rebuild; the legacy
      // case will crash. Refuse both unless `force: true` is passed
      // (operator opt-in to attempt rebuild on a corpus they know is
      // small enough — typically under 10K nodes on the default iii
      // state adapter).
      // Strict boolean check on force — accept only literal `true`,
      // never truthy strings/numbers, so a hand-crafted JSON payload
      // can't accidentally bypass the legacy-corpus safeguard.
      const forceRebuild = data?.force === true;
      try {
        const enumeration = await checkGraphEnumerable(kv);
        // force is an operator opt-in for a corpus they believe is small.
        // It must NOT bypass a scope the snapshot has already sized past
        // the byte budget: that read is rejected at the ws frame length
        // header and kills the worker, which no `force` can consent to on
        // behalf of every other in-flight request.
        const overByteBudget = enumeration.blockedScope !== null;
        if (!enumeration.enumerable && (!forceRebuild || overByteBudget)) {
          logger.warn("Graph snapshot rebuild refused", {
            totalNodes: enumeration.totalNodes,
            totalEdges: enumeration.totalEdges,
            ceiling: enumeration.ceiling,
            blockedScope: enumeration.blockedScope,
            estimatedNodeBytes: enumeration.nodeBytes,
            estimatedEdgeBytes: enumeration.edgeBytes,
            byteBudget: enumeration.byteBudget,
          });
          return {
            success: false,
            legacyCorpus:
              enumeration.totalNodes === null || enumeration.totalNodes === 0,
            tooLarge:
              enumeration.blockedScope !== null ||
              (enumeration.totalNodes !== null &&
                enumeration.totalNodes > enumeration.ceiling),
            totalNodes: enumeration.totalNodes ?? undefined,
            ceiling: enumeration.ceiling,
            error:
              `Rebuild refused: ${describeCorpusSize(enumeration)}. Rebuild ` +
              "would call kv.list on KV.graphNodes/Edges, whose response " +
              "frame is rejected at its length header once the scope is " +
              "large enough — the worker dies before any budget can fire. " +
              "Either (a) call POST /agentmemory/graph/reset to drop into " +
              "incremental-only mode and rebuild from new extracts, or " +
              "(b) re-send with `force: true` if you're certain the " +
              "corpus is small.",
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph snapshot pre-flight read failed", { error: msg });
        // Fail closed. Falling through here reaches the raw kv.list below,
        // and an unsized graph scope is exactly the read that kills the
        // worker. A failed pre-flight means we do not know the size, which
        // is not permission to attempt it.
        return {
          success: false,
          preflightFailed: true,
          error:
            `Rebuild refused: graph size pre-flight failed (${msg}). ` +
            "Rebuild would call kv.list on KV.graphNodes/Edges, whose " +
            "response frame is rejected at its length header once the " +
            "scope is large enough, killing the worker. Retry once the " +
            "snapshot is readable, or call POST /agentmemory/graph/reset " +
            "to drop into incremental-only mode.",
        };
      }

      try {
        const [nodes, edges] = await withTimeout(
          Promise.all([
            kv.list<GraphNode>(KV.graphNodes),
            kv.list<GraphEdge>(KV.graphEdges),
          ]),
          LIVE_ENUMERATION_BUDGET_MS,
          "graph-snapshot-rebuild enumeration",
        );

      if (nodes.length > SAFE_ENUMERATION_NODE_CEILING) {
        logger.warn("Graph snapshot rebuild aborted: corpus too large", {
          totalNodes: nodes.length,
          ceiling: SAFE_ENUMERATION_NODE_CEILING,
        });
        return {
          success: false,
          tooLarge: true,
          totalNodes: nodes.length,
          ceiling: SAFE_ENUMERATION_NODE_CEILING,
          error:
            `Corpus has ${nodes.length} graph nodes; safe-rebuild ceiling ` +
            `is ${SAFE_ENUMERATION_NODE_CEILING}. Run POST /agentmemory/graph/reset ` +
            `to wipe and let future extracts rebuild incrementally.`,
        };
      }

      // Backfill the targeted-lookup indexes so post-rebuild
      // graph-extract calls hit the O(1) path instead of falling
      // through to the (already-removed) full-scope scan. Batch
      // writes via Promise.all to avoid N sequential round-trips —
      // BATCH_SIZE bounds in-flight writes so we don't open thousands
      // of concurrent state channels on huge corpora.
      const liveNodes = nodes.filter((n) => !n.stale);
      const liveEdges = edges.filter((e) => !e.stale);
      const degree = new Map<string, number>();
      for (const e of liveEdges) {
        degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
        degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
      }
      const BATCH_SIZE = 100;
      for (let i = 0; i < liveNodes.length; i += BATCH_SIZE) {
        const batch = liveNodes.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.flatMap((n) => [
            guardedSet(kv, KV.graphNameIndex, nameIndexKey(n.type, n.name), n.id),
            guardedSet(kv, KV.graphNodeDegree, n.id, degree.get(n.id) ?? 0),
          ]),
        );
      }
      for (let i = 0; i < liveEdges.length; i += BATCH_SIZE) {
        const batch = liveEdges.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map((e) =>
            guardedSet(
              kv,
              KV.graphEdgeKey,
              edgeIndexKey(e.sourceNodeId, e.targetNodeId, e.type),
              e.id,
            ),
          ),
        );
      }

      const snap = buildSnapshotFromArrays(nodes, edges);
      // The other place a full snapshot is written; same measurement.
      const rebuildLedger = newWriteLedger();
      await guardedSet(kv, KV.graphSnapshot, SNAPSHOT_KEY, snap, rebuildLedger, {
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
      });
      const tookMs = Date.now() - started;
      logger.info("Graph snapshot rebuilt", {
        totalNodes: snap.stats.totalNodes,
        totalEdges: snap.stats.totalEdges,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        snapshotBytes: rebuildLedger.bytes,
        tookMs,
      });
      return {
        success: true,
        totalNodes: snap.stats.totalNodes,
        totalEdges: snap.stats.totalEdges,
        nodesByType: snap.stats.nodesByType,
        edgesByType: snap.stats.edgesByType,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        updatedAt: snap.updatedAt,
        tookMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Graph snapshot rebuild failed", { error: msg });
      return { success: false, error: msg };
    }
  });

  // #814 v2 + #825: clean-restart escape hatch for corpora of any
  // size, including the legacy 75K+ case that crashes kv.list.
  //
  // Previous reset walked kv.list<GraphNode/Edge>(...) which is the
  // exact primitive that heartbeat-crashes the worker on the corpus
  // this reset was meant to recover (Allan's repro, 0.35s death).
  //
  // The new design is enumeration-free: write an empty snapshot and
  // return. The hot path (mem::graph-query empty-body, mem::graph-stats)
  // reads ONLY the snapshot post-#816, so a fresh empty snapshot
  // makes the graph behave as if it were empty for every read.
  //
  // Future extracts repopulate the snapshot + side-indexes
  // incrementally (graph-extract is O(1) per node post-#816 — it does
  // not consult the legacy rows).
  //
  // Trade-off: legacy rows in KV.graphNodes / KV.graphEdges remain on
  // disk as unreferenced orphans. They consume disk but are never
  // read by any post-#816 code path. Cleanup is deferred to a future
  // chunked-vacuum job; #816's broken vacuum-via-list strategy is
  // what we are leaving behind here.
  sdk.registerFunction("mem::graph-reset", async () => {
    const started = Date.now();
    // Stamp resetAt=now on the empty snapshot. Future
    // mem::graph-extract calls compare each name-index lookup's
    // existing node `createdAt` against this timestamp; anything
    // older counts as an orphan and is dropped from the merge path,
    // forcing extract to write a fresh row instead of reconnecting
    // to a pre-reset entry.
    const resetSnapshot: GraphSnapshot = {
      ...emptySnapshot(),
      resetAt: new Date().toISOString(),
    };
    await guardedSet(kv, KV.graphSnapshot, SNAPSHOT_KEY, resetSnapshot);
    const counts: Record<string, number> = {
      [KV.graphSnapshot]: 1,
    };
    const tookMs = Date.now() - started;
    logger.info("Graph state reset", { counts, tookMs });
    return { success: true, cleared: counts, tookMs };
  });
}
