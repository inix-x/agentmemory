---
title: "U3 build record: the index write path and the cascade rewiring"
date: 2026-09-06
type: build
plan: docs/plans/2026-09-06-001-graph-memory-redesign-plan.md
branch: feat/u3-graph-index-write-path
parent: fa2f5ef
---

# U3 build record: the index write path and the cascade rewiring

Ten commits on `feat/u3-graph-index-write-path`, branched off U1's head
`fa2f5ef` so the `guardedSet` write helper and the projected snapshot are
present. The write half of U3 only: the read path, `graph-retrieval.ts`, is a
separate task. Not pushed, not deployed, no sandbox run.

## Limitations, first

0. **One test regressed on the branch and is a pre-existing flake, traced not
   assumed.** `test/session-sweep.test.ts > leaves a session sitting exactly on
   the threshold alone` failed once in a full run and passes in isolation on
   both this branch and `dd59718`. It is a clock-boundary race in the test:
   line 303 sets `updatedAt` to exactly `Date.now() - idleMinutes*60*1000`, the
   sweep compares with `<=`, and any wall-clock advance before the comparison
   makes the session a candidate. `src/functions/session-sweep.ts` imports only
   `iii-sdk`, `types`, `schema`, `kv`, `audit`, and `logger`; the one U3 touches
   is `schema.ts`, and U3's change there is three added constant strings. It
   cannot reach a timestamp comparison. Worth its own one-line fix, not in this
   unit.
1. **`mem:graph:obs-index` is larger than the plan's "linear in observations"
   suggests, and this is Q2's answer.** Worked below under "Index sizing". The
   short form: an entry is written per observation per extract and holds every
   row that extract touched, so the corpus-wide pair count carries a factor of
   the batch size. At the measured 10-observation batch and 71 rows touched per
   extract, replaying 306,791 observations produces roughly **21.8M pairs, about
   545 MB** — the same order as the 33.8M-pair transpose KTD2 rejected. The
   read-path win is unaffected. The disk win is not there in this shape. A
   variant that removes the batch-size factor is proposed below; it was not
   built, because it is a design change the plan does not specify and it belongs
   with a measurement rather than at the end of this task. `7b27a0b` caps an
   entry at 512 ids, which bounds the worst case per key but does not remove the
   corpus-wide factor.
2. **The backfill cannot run on production today.** It enumerates, and
   production's graph is over the enumeration budget, so it refuses and says so.
   It becomes available after U2's rebuild takes the row scopes from 2,039 MiB
   to about 28 MiB. Until then, indexes exist only for rows written after this
   deploys.
3. **Cascade stops flagging rows that have no obs-index entry.** That is the
   intended abandon-and-replay position and it is now loud rather than silent: a
   named warn line and a response warning naming `mem::graph-index-backfill`.
   Before the backfill runs, that is every row already on disk.
4. **`npm test` is not green.** 6 failures on the final run. Five are the known
   loaded-machine flaky set and are present on the parent; the sixth is the
   session-sweep boundary race traced in Limitation 0. None is in a file this
   branch touches. Attribution below.
5. **No sandbox measurement.** Every number here is from unit tests or from the
   09-05 census. U3's promotion gate is a sandbox sample and nothing here
   substitutes for it.
6. **Clear-all leaves `mem:graph:obs-index` behind.** Deliberate, reasoned, and
   pinned by a test. See commit `df23240`.

## Commits

| hash | title | what it does |
|---|---|---|
| `459e749` | `feat(graph): add graph-store with the three append-only index scopes` | `src/state/graph-store.ts` plus `mem:graph:adj`, `mem:graph:obs-index`, `mem:graph:names` in `schema.ts`. Owns the merges, the 64-stub cap, the per-call delta, and the row writers. |
| `ca7efc2` | `feat(graph): maintain the indexes inside persistGraphDelta` | Index maintenance in the single writer extract and graphify already share, coalesced across the call and flushed once, before the snapshot write. |
| `8fd05ae` | `feat(cascade): flag stale rows through obs-index instead of resolving every row` | `mem::cascade-update` reads the inverted index instead of enumerating both scopes and testing membership on every row. |
| `6ff57ae` | `feat(graph): backfill the indexes from existing rows once` | `mem::graph-index-backfill`, off behind `GRAPH_INDEX_BACKFILL`, bounded per run and resumable from a cursor. |
| `df23240` | `feat(graph): route the import path through graph-store` | `mem::import` restore and clear-all, so the one writer that bypassed the store no longer does. |
| `f529884` | `test(graph): update two suites the index write path changed` | Two suites the full-suite run caught, not the per-commit runs. |

Four follow-up commits from the review pass. Two of them close defects, not
tidiness.

| hash | title | what it fixes |
|---|---|---|
| `7b27a0b` | `fix(graph): cap an obs-index entry and count a refused index write` | An obs-index entry was an unbounded array under one key, merged forever -- the shape that grew the snapshot to 16 MiB, rebuilt one scope over. Capped at 512, oldest first. `flushIndexDelta` also ignored every write result, so a refusal vanished; it counts them now. |
| `e9a181d` | `fix(graph): coalesce the import's adjacency writes so hub stubs survive` | **A correctness bug.** Per-edge read-merge-write inside the import's `Promise.all` meant two edges sharing an endpoint both read the pre-merge value and the second write lost the first's stub. Measured: importing 40 edges onto one hub kept 2. |
| `df582fc` | `fix(cascade): do not count a stale flag the frame guard refused` | Cascade counted a flag after a write it never checked, so a refused write would report a row stale while it stayed live. Also adds the backfill case where the nodes exhaust the row budget across more than one run. |
| `cafa310`, and this edit | `docs(u3)` | This record. |

Diff against `fa2f5ef`: 14 files, about 1,540 insertions, 80 deletions.

## Index sizing, against the 09-05 census

Census inputs: 37,039 reachable nodes, 73,835 reachable edges, 306,791
observations. Per-extract shape from tick 12's `Graph delta persisted` line:
`nodes: 35, edges: 36`, at `GRAPH_EXTRACTION_BATCH_SIZE` 10.

**`mem:graph:names`** — one entry per node, `{id, type, name}`. Id 25 B, type up
to 12 B, name at the observed mean, plus JSON: 60 to 90 B. At 37,039 nodes,
**about 2.8 MiB**, which matches the plan. The `listBounded` 15 MiB ceiling is
about 190K nodes, roughly 5x the reachable corpus.

**`mem:graph:adj`** — two stubs per edge, one on each endpoint. 73,835 edges is
147,670 stubs at about 80 B each, **about 11.3 MiB** across 37,039 keys, so a
mean of 4.0 stubs and about 320 B per key. The 64-stub cap puts a ceiling of
about 5.1 KB on any one key, and at mean degree 4.0 it binds on hubs only. How
many rows exceed 64 incident edges is a one-pass count after backfill.

**`mem:graph:obs-index`** — the open item, and the number that does not come out
where the plan expected.

An extract touches about 71 rows and carries about 10 observation ids. Every one
of those observations gets an entry naming all 71 rows, so one extract writes
about 710 pairs. Replaying 306,791 observations is about 30,679 extracts:

```
30,679 extracts x 710 pairs  =  21.8M pairs
21.8M pairs x 25 B per row id  =  about 545 MB
```

Against the transpose KTD2 rejected at 33.8M pairs and about 902 MiB, that is a
1.5x improvement, not the order-of-magnitude "linear in observations" implies.
The linearity claim is true and the constant is what hurts: the factor is the
batch size, because the same 71-row list is written once per observation in the
batch rather than once per batch.

**The variant that removes it, not built.** Store the touched rows once per
extraction and point observations at it: extend `mem:graph:batches` from
`batchId -> {observationIds}` to `batchId -> {observationIds, nodes, edges}`, and
make obs-index `obsId -> [batchId]`. One extract then writes about 71 row ids
once plus 10 short batch-id entries, roughly 81 pairs instead of 710, a 9x cut to
about 60 MB. Cost: cascade takes two hops instead of one, and `mem:graph:batches`
becomes load-bearing for retrieval rather than provenance alone.

Recommendation: measure the real per-extract pair count in the sandbox before
U3's read path lands, then decide. The write path as built is correct and the
change is contained to the store and cascade.

## Corrections to the plan, made against the tree

1. **`obsId -> [nodeId]` cannot serve cascade.** `mem::cascade-update` flags
   edges as well as nodes, and R6 requires the flagging to stay exact, so the
   entry carries `{nodes, edges}`. Relying on the `gn_` / `ge_` id prefixes to
   tell them apart was the alternative and was rejected: `graph-import.ts` and
   `temporal-graph.ts` mint rows too, and an import restores whatever id the
   export carried. A test covers the case only the two-list shape answers, an
   edge whose observation overlaps when no node's does.
2. **"No read-modify-write anywhere in the new surface" is not achievable.**
   U-C v2 claimed it. An append to an array under a key is a get plus a set
   unless the engine offers an append primitive, and `state::update`'s op shape
   is not one this codebase can rely on: `src/state/kv.ts:23` declares
   `{type, path, value}` and the test double takes `{path, value}`. What holds is
   the property that matters, that content is immutable once written, so a
   concurrent append can duplicate but cannot corrupt, and the merges dedupe.
   This is the same read-modify-write the snapshot maintenance next door already
   performs.
3. **The backfill reads through `listGraphScopes`, not `listBounded`.** Both
   refuse an over-budget scope. `listBounded` also records an unfinished-attempt
   marker keyed by scope (`scope-size.ts:134-145`) and refuses after
   `MAX_UNFINISHED_ATTEMPTS`, so a backfill that died mid-read would latch
   `mem::export` and `mem::reflect` off the same two scopes. `listGraphScopes`
   decides from the snapshot and leaves no marker.
4. **`graph-store.ts` takes `guardedSet` as a parameter rather than importing
   it.** `graph.ts` imports the store, so the store importing `graph.ts` back
   would be a cycle. `graphWriter(kv, ledger)` in `graph.ts` binds it, and every
   production caller passes it, so every index write is still frame-checked.

## Fail-then-pass

Every test below was run against the parent before the source change and the
failure is quoted.

**`459e749` — the store module.** `test/graph-store.test.ts`, 7 tests:

```
Error: Cannot find module '../src/state/graph-store.js'
```

**`ca7efc2` — index maintenance.** 3 tests added to `test/graph-store.test.ts`,
run with `src/functions/graph.ts` stashed to the parent:

```
× indexes a fresh batch by catalog, adjacency, and observation
× links a merged row to the new batch's observations
× builds obs-index from the extraction event, not from row provenance
AssertionError: expected [] to deeply equal [ 'gn_a' ]
```

`test/graph-scope-enumeration.test.ts` also gains a guard that the write path
makes no `kv.list` at all. **It passes against the parent**, because the write
path did not enumerate before either. It is here so that maintaining three more
scopes cannot quietly become the way enumeration returns.

**`8fd05ae` — cascade.** 3 tests added to `test/cascade.test.ts`, run with
`src/functions/cascade.ts` stashed to the parent:

```
× flags the same rows with kv.list on the graph scopes throwing
    AssertionError: expected +0 to be 2
× flags an edge whose observation overlaps even when no node does
    AssertionError: expected +0 to be 1
× says so loudly when the rows predate the index
    AssertionError: expected 'graph enumeration refused; graph rows…'
                    to contain 'mem::graph-index-backfill'
```

**`6ff57ae` — the backfill.** `test/graph-index-backfill.test.ts`, 4 tests:

```
Error: Cannot find module '/src/functions/graph-index-backfill.js'
```

**`df23240` — export-import.** 2 tests added to `test/graph-store.test.ts`, run
with `src/functions/export-import.ts` stashed to the parent:

```
× indexes a restored graph by catalog and adjacency
× clears the indexes when it clears the rows
    AssertionError: expected 2 to be +0
```

### Mutation checks

| mutation | result |
|---|---|
| drop the 64-stub adjacency cap | `expected [ { edgeId: 'e99', …(2) }, …(99) ] to have a length of 64 but got 100` |
| drop the obs-index dedupe on merge | `expected [ 'a', 'a' ] to deeply equal [ 'a' ]` |
| make `flushIndexDelta` list the adj scope | `expected [ 'mem:graph:adj' ] to deeply equal []` |
| drop `recordEdgeAdjacency` from `persistGraphDelta` | `expected [] to deeply equal [ { edgeId: 'ge_1', …(2) } ]` |
| drop edge ids from cascade's obs-index read | three cascade tests die |
| silence cascade's unindexed flag | the degradation test dies on the missing warning |
| ignore the backfill's resume cursor | `expected [ Array(6) ] to deeply equal [ 'gn_4', 'gn_5' ]` |
| drop the backfill's enumeration refusal | `expected true to be false` |
| make import write the row only | the restore test dies |
| make clear-all leave the catalog | `expected 2 to be +0` |
| drop the obs-index entry cap | `expected [ 'gn_0', …(549) ] to have a length of 512 but got 552` |
| make `flushIndexDelta` ignore refusals | `expected +0 to be 1` |
| do the import's adjacency per edge inside the chunk | `expected [ …(1) ] to have a length of 40 but got 2` |
| count a cascade flag without checking the write | `expected 1 to be +0` |

The resume-cursor mutation is worth naming. It did not die at first, because
every index write is an idempotent merge, so redoing the first run's work is
invisible in the result. The test was rewritten to assert on the writes rather
than the result, which is the only place a broken cursor shows.

## Gates

| gate | result |
|---|---|
| `npx tsc --noEmit` | **29 errors, identical to the `fa2f5ef` baseline.** Normalised diff empty. Checked after every commit. |
| `npm run build` | **pass**, exit 0, 20 files / 3.23 MB. |
| `npm test` | **not green.** 3 failures, zero attributable to this branch. |

`npm test` attribution, same method U1 used:

- parent `fa2f5ef`, same session: **15 failures / 12 files**.
- branch, first full run: 7 failures, of which **2 were branch-only and real**
  (`graph-provenance-batch`, `graph-write-frame-diagnostic`). Both were test
  expectations this change invalidated, both were fixed in `f529884`. Neither
  was caught by the per-commit runs, which is the argument for running the full
  gate before calling a unit done.
- branch, after `f529884`: **3 failures / 3 files, branch-only: 0.**
- branch, final state after the four review fixes: **6 failures / 4 files.**
  Five are the same loaded-machine flaky set `.claude/rules/pr-governance.md`
  records and are present on the parent. The sixth, `session-sweep`, is the
  boundary race traced in Limitation 0; it passes in isolation on this branch
  and on `dd59718`, and a baseline rerun under the same load did not reproduce
  it.

## What the sandbox proof must read

U3's read path is a later task and the plan's gate belongs to it. What this half
can be checked on:

1. **`Graph delta persisted` gains an `index` field**: `{adj, obs, names,
   refused}` counts per extract. A non-zero `refused` means an index write went
   over the frame and was not dispatched; it should be zero. Read the per-extract pair rate from it and settle the sizing
   question in "Index sizing" with a measurement instead of the tick-12
   extrapolation. `obs` times the batch size against `adj` plus `names` is the
   ratio the batch-indirection variant would remove.
2. **On-disk size of the three new scopes** after a window of extracts, against
   the projections above: names about 60 to 90 B per node, adj about 320 B per
   node at mean degree 4.0, obs-index the open one.
3. **Zero new `Graph scope enumeration refused` lines from the write path.** The
   write path takes no `kv.list`, so any refusal in the window belongs to
   `mem::reflect`, `mem::export`, or the rebuild endpoint, which still enumerate
   by design.
4. **`Cascade found no obs-index entries for the superseded memory`.** Expected
   for every pre-index row until the backfill runs. The count is the honest
   measure of how much of the corpus is still dark to cascade.
5. **`worker_registrations: 0` and `livez_ok: 1`.** This unit adds two to four
   writes per extract on top of about 250; it should not move either, and if it
   does the coalescing is not working.
6. **A count of rows over 64 incident edges**, one pass over `mem:graph:adj`
   after the backfill. That is the size of the fanout-cap delta U-C v2 could not
   measure and this makes measurable.

## Composition with U1 and U2

**U1** is this branch's parent, and `guardedSet` is the reason every index write
is frame-checked. `graphWriter(kv, ledger)` binds it. Nothing here reverses or
reworks U1.

**U2 depends on this landing first, and KTD5 is right about why.** U2 caps
`sourceBatchIds`, so a row touched by more than the cap resolves only its most
recent batches. The old cascade tested membership against that resolved list and
would have silently under-flagged the moment the cap shipped. Cascade no longer
reads row provenance at all, so the cap cannot reach it. That is the whole
sequencing argument, and it is now satisfied.

Both units touch `src/functions/graph.ts`. U3 adds index maintenance to
`persistGraphDelta`'s node and edge branches; U2 changes the merge functions those
branches call and adds the rebuild. They do not overlap. State the composition in
both PR bodies per `.claude/rules/pr-governance.md`.

One forward note for U2's rebuild: it writes rows through
`export-import.ts:485-502`, which now routes through `graph-store`, so the
rewritten corpus gets its catalog and adjacency for free. obs-index does not come
with it, so the rebuild should be followed by `mem::graph-index-backfill`, which
by then can run because the corpus is under the enumeration budget.
