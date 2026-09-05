import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import type { GraphEdge, GraphNode } from "../types.js";

// U3. The three append-only indexes that let the search path answer without
// enumerating mem:graph:nodes or mem:graph:edges. Retrieval has four entry
// points and every one of them today loads the whole corpus and filters in JS,
// which the scope-size guard correctly refuses, which is why graph retrieval has
// been dark in production since 2026-09-01T19:04:13Z.
//
//   mem:graph:adj        nodeId -> [{ edgeId, neighborId, weight }]
//   mem:graph:obs-index  obsId  -> { nodes: [rowId], edges: [rowId] }
//   mem:graph:names      nodeId -> { id, type, name }
//
// Content is immutable once written, which is what makes an append safe:
//   - a node's id and name are identity (nameIndexKey), so a catalog row never
//     needs updating;
//   - mergeEdge unions provenance only, never weight and never endpoints, so an
//     adjacency stub written at edge creation cannot drift;
//   - stale-marking mutates the ROW, and traversal filters stale after
//     hydrating rows, exactly as loadGraph does today;
//   - a replayed extract appends what is already there, and the merges below
//     dedupe it.
//
// "Append-only" describes the content, not the mechanism. The engine's
// state::update op shape is not one this codebase can rely on (src/state/kv.ts
// declares { type, path, value } and the test double takes { path, value }), so
// an append is a get followed by a guarded set, the same read-modify-write the
// snapshot maintenance next door already performs.

// Fanout cap. The reachable corpus is 73,835 edges over 37,039 nodes, so mean
// degree is 4.0 and this binds on hubs only. Ordered by stub weight; a hydrated
// edge still uses its fresh weight for traversal cost.
export const GRAPH_ADJ_CAP = 64;

// The obs-index entry ceiling, and it exists for the same reason U1's snapshot
// bound does. An entry accumulates every row an extraction linked to that
// observation, and re-extraction unions more in forever: an unbounded array
// under one key, merged on every write, which is exactly the shape that grew
// mem:graph:snapshot to 16 MiB and closed the engine's socket. An extract
// touches about 71 rows, so 512 is generous against the typical entry while
// holding a ceiling near 13 KB. Oldest ids go first, matching the convention
// KTD2 sets for sourceBatchIds.
export const GRAPH_OBS_INDEX_CAP = 512;

export type GraphAdjStub = {
  edgeId: string;
  neighborId: string;
  weight: number;
};

export type GraphNameEntry = { id: string; type: string; name: string };

// The plan's table writes this as obsId -> [nodeId]. That shape cannot serve
// mem::cascade-update, which flags edges as well as nodes (cascade.ts:66-78) and
// which R6 requires to stay exact, so the value carries both row kinds rather
// than relying on the gn_ / ge_ id prefixes to tell them apart.
export type GraphObsIndexEntry = { nodes: string[]; edges: string[] };

// Every write here goes through U1's guardedSet. It arrives as a parameter
// rather than an import so this module stays a leaf: graph.ts imports the store
// and the store does not import graph.ts back.
export type GuardedWrite = <T>(
  scope: string,
  key: string,
  value: T,
) => Promise<unknown>;

// --- merges, pure so the invariants are testable without a kv ---

export function mergeAdj(
  existing: GraphAdjStub[],
  incoming: GraphAdjStub[],
): GraphAdjStub[] {
  const byEdge = new Map<string, GraphAdjStub>();
  for (const stub of existing) byEdge.set(stub.edgeId, stub);
  for (const stub of incoming) byEdge.set(stub.edgeId, stub);
  return [...byEdge.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, GRAPH_ADJ_CAP);
}

function capOldest(ids: Iterable<string>): string[] {
  const deduped = [...new Set(ids)];
  return deduped.length > GRAPH_OBS_INDEX_CAP
    ? deduped.slice(deduped.length - GRAPH_OBS_INDEX_CAP)
    : deduped;
}

export function mergeObsIndex(
  existing: GraphObsIndexEntry | null,
  nodes: Iterable<string>,
  edges: Iterable<string>,
): GraphObsIndexEntry {
  return {
    nodes: capOldest([...(existing?.nodes ?? []), ...nodes]),
    edges: capOldest([...(existing?.edges ?? []), ...edges]),
  };
}

// --- the per-call delta ---

// Index writes are coalesced across a whole persistGraphDelta call and flushed
// once. Appending inline would put two read-modify-writes on the adjacency key
// per new edge, and a batch that adds 36 edges to a handful of hubs would do 72
// of them against a few keys. It also makes the cap correct: capping on every
// append can evict a stub that a later edge in the same batch outranks.
export type GraphIndexDelta = {
  adj: Map<string, GraphAdjStub[]>;
  obs: Map<string, { nodes: Set<string>; edges: Set<string> }>;
  names: Map<string, GraphNameEntry>;
};

export function newIndexDelta(): GraphIndexDelta {
  return { adj: new Map(), obs: new Map(), names: new Map() };
}

export function recordNodeName(delta: GraphIndexDelta, node: GraphNode): void {
  delta.names.set(node.id, { id: node.id, type: node.type, name: node.name });
}

function obsSlot(delta: GraphIndexDelta, obsId: string) {
  let slot = delta.obs.get(obsId);
  if (!slot) {
    slot = { nodes: new Set<string>(), edges: new Set<string>() };
    delta.obs.set(obsId, slot);
  }
  return slot;
}

// KTD2: obs-index is built from the extraction event -- the batch's observation
// ids against the rows that batch touched -- and never by transposing a row's
// sourceObservationIds. The transpose holds all 33,767,235 reachable pairs, about
// 902 MiB; this is linear in observations.
export function recordRowObservations(
  delta: GraphIndexDelta,
  obsIds: readonly string[],
  rowId: string,
  kind: "node" | "edge",
): void {
  for (const obsId of obsIds) {
    const slot = obsSlot(delta, obsId);
    if (kind === "node") slot.nodes.add(rowId);
    else slot.edges.add(rowId);
  }
}

export function recordEdgeAdjacency(
  delta: GraphIndexDelta,
  edge: GraphEdge,
): void {
  const push = (nodeId: string, neighborId: string) => {
    const stubs = delta.adj.get(nodeId) ?? [];
    stubs.push({ edgeId: edge.id, neighborId, weight: edge.weight });
    delta.adj.set(nodeId, stubs);
  };
  push(edge.sourceNodeId, edge.targetNodeId);
  push(edge.targetNodeId, edge.sourceNodeId);
}

export type GraphIndexFlushCounts = {
  adj: number;
  obs: number;
  names: number;
  // guardedSet refuses an oversized value and returns rather than throws, so a
  // flush that ignored the result would drop an index write silently. Counted
  // here and reported in the per-call summary.
  refused: number;
};

function wasRefused(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { oversized?: unknown }).oversized === true
  );
}

export async function flushIndexDelta(
  kv: StateKV,
  delta: GraphIndexDelta,
  write: GuardedWrite,
): Promise<GraphIndexFlushCounts> {
  let refused = 0;
  const record = (result: unknown) => {
    if (wasRefused(result)) refused++;
  };
  for (const [nodeId, stubs] of delta.adj) {
    const existing =
      (await kv.get<GraphAdjStub[]>(KV.graphAdj, nodeId).catch(() => null)) ?? [];
    record(await write(KV.graphAdj, nodeId, mergeAdj(existing, stubs)));
  }
  for (const [obsId, slot] of delta.obs) {
    const existing = await kv
      .get<GraphObsIndexEntry>(KV.graphObsIndex, obsId)
      .catch(() => null);
    record(
      await write(
        KV.graphObsIndex,
        obsId,
        mergeObsIndex(existing, slot.nodes, slot.edges),
      ),
    );
  }
  for (const [nodeId, entry] of delta.names) {
    record(await write(KV.graphNames, nodeId, entry));
  }
  return {
    adj: delta.adj.size,
    obs: delta.obs.size,
    names: delta.names.size,
    refused,
  };
}

// --- reads ---

export async function readAdj(
  kv: StateKV,
  nodeId: string,
): Promise<GraphAdjStub[]> {
  return (
    (await kv.get<GraphAdjStub[]>(KV.graphAdj, nodeId).catch(() => null)) ?? []
  );
}

export async function readObsIndex(
  kv: StateKV,
  obsId: string,
): Promise<GraphObsIndexEntry> {
  return (
    (await kv
      .get<GraphObsIndexEntry>(KV.graphObsIndex, obsId)
      .catch(() => null)) ?? { nodes: [], edges: [] }
  );
}

// --- row writers, for callers that restore rows rather than merge them ---

// Import writes rows verbatim, with no extraction event behind them, so it can
// derive the catalog entry and the adjacency stubs from the row itself but not
// the obs-index. That gap is the backfill's job, and the store refuses to
// transpose sourceObservationIds here for the reason KTD2 gives.
export async function putGraphNodeRow(
  node: GraphNode,
  write: GuardedWrite,
): Promise<void> {
  await write(KV.graphNodes, node.id, node);
  await write(KV.graphNames, node.id, {
    id: node.id,
    type: node.type,
    name: node.name,
  });
}

export async function putGraphEdgeRow(
  kv: StateKV,
  edge: GraphEdge,
  write: GuardedWrite,
): Promise<void> {
  await write(KV.graphEdges, edge.id, edge);
  const delta = newIndexDelta();
  recordEdgeAdjacency(delta, edge);
  for (const [nodeId, stubs] of delta.adj) {
    const existing = await readAdj(kv, nodeId);
    await write(KV.graphAdj, nodeId, mergeAdj(existing, stubs));
  }
}

export const GRAPH_INDEX_SCOPES = [
  KV.graphAdj,
  KV.graphObsIndex,
  KV.graphNames,
] as const;
