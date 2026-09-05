---
title: "U1 build record: frame-safe graph writes"
date: 2026-09-06
type: build
plan: docs/plans/2026-09-06-001-graph-memory-redesign-plan.md
branch: feat/u1-frame-safe-graph-writes
parent: dd59718
---

# U1 build record: frame-safe graph writes

Seven commits on `feat/u1-frame-safe-graph-writes`, branched off `dd59718`
(production `878174f` plus the log-only graph-write diagnostic). Not pushed, not
deployed, no sandbox run. This document records what was built, what was proved,
and what a reader must not assume.

## Limitations, first

1. **No sandbox measurement was taken.** Every number below comes from unit tests
   and from the plan's own census. U1's promotion gate is a sandbox sample, and
   nothing here substitutes for it. The gate list is at the end.
2. **`npm test` on the branch is NOT green.** The final run ended with 8
   failures; two earlier runs, on a busier machine, ended with 14 each. **Zero of
   them are attributable to U1**, proved by running the same command on the
   parent commit under the same machine load: the parent produced 25 failures,
   and every single branch failure appears in a parent run. Zero failures sit in
   a file U1 touches. The suite is loaded-machine flaky in this tree; the quiet
   baseline taken before any edit was 4 failures
   (`test/antigravity-connect-hooks.test.ts` 1, `test/copilot-plugin.test.ts` 3),
   and all four are in the final run. This is reported as "not green, with
   attribution proved", not as "verified".
3. **A.7 predicts U1's effect on peak memory is small.** U1 makes the snapshot
   write land, so the extract finishes in seconds instead of 33. The row writes
   still dirty the same two gigabyte-scale scopes, so the engine's save-loop
   clone still happens. U2 is the unit that removes the memory step. Per KTD4,
   do not apply the peak-only 5% discard to U1.
4. **The shrink loop is untested against production's actual shape**, because at
   the projected size it never runs. Its coverage is a synthetic corpus.
5. **One plan number could not be reconciled** against the tree, and it is the
   justification for one of the changes. See "Unresolved: topEdges 2,454 vs
   1,000" below. The change was made anyway, because it is correct under both
   readings and costs four lines.

## Commits

| hash | title | what it does |
|---|---|---|
| `260c55e` | `feat(graph): route every graph write through a frame-size guard` | `measuredSet` becomes `guardedSet`: runs `checkPayloadFrameSize` on the exact `{scope,key,value}` object `StateKV.set` serialises and returns `OversizedPayload` without dispatching. All fifteen `kv.set` sites in `graph.ts` route through it. |
| `6e1889e` | `feat(graph): snapshot rows carry identity and rank, not provenance` | `GraphSnapshotNode` / `GraphSnapshotEdge` in `src/types.ts`; the projection applied at all seven sites that write into `topNodes` / `topEdges`. Also repairs the enumeration guard, which the projection would otherwise have loosened. |
| `740876d` | `feat(graph): bound the snapshot by bytes and shrink an oversized topEdges` | `SNAPSHOT_BUDGET_BYTES = 4 MiB`; a proportional shrink loop before the write; `topEdges` truncated to `SNAPSHOT_TOP_EDGES` by weight wherever a snapshot is loaded or built. Retargets the two diagnostic fixtures, which relied on an oversized snapshot the bound now prevents. |
| `3137220` | `test(graph): a merge-only batch does not rewrite the snapshot` | Test-only. **R4's gate already holds on the parent**; this test passed unmodified against `dd59718` and is recorded as such. |

Three follow-up commits from the review pass. Each is a distinct logical change,
so each gets its own commit rather than an amend, per
`.claude/rules/commit-convention.md`.

| hash | title | what it fixes |
|---|---|---|
| `9e2fe77` | `fix(graph): keep the measured row size a monotonic upper bound` | The write-path row-size sample covers only the rows that batch wrote. A thin batch dropped the recorded size from 20,000 bytes to 179, re-opening the enumeration loosening by a different door. Take the max on the write path; the rebuild still ratchets it down from a representative sample. |
| `9e987d2` | `fix(graph): account a refused write in the write ledger` | `guardedSet` returned above the ledger accounting, so a refused write reported no bytes and `snapshotBytes` read `undefined` on the one call where the size is the whole story. Refusals now record bytes and a `refused` count, separate from `writes`. |
| `0cdf000` | `fix(graph): keep the row-size stats out of the public stats shape` | `mem::graph-stats` and `mem::graph-snapshot-rebuild` spread `snap.stats`, so the two new internal fields silently widened `/graph/stats` and `/graph/build`. Both now name the four count fields. |

Diff, source and tests only: 6 files, 583 insertions, 96 deletions. Plus this
document.

## Q5 resolved: strip-only, not lean

The plan left the cached row's shape to the implementer, to be settled by reading
what the viewer renders (Q5, D5).

`src/viewer/index.html` copies four fields off every row the graph query returns,
at `:2034` (initial load) and `:2204` (node expansion):

```js
id: n.id, type: n.type, name: n.name, properties: n.properties,
```

and renders `properties` in two places: the hover tooltip, up to three keys
(`:2109-2112`), and the node detail sidebar, all keys (`:2177-2179`).

The lean row `{id, type, name, degree}` drops `properties`. The viewer's default
tab load is served from the snapshot fast path on any corpus large enough to
matter, so lean would blank the tooltip and the sidebar there. D5 names
strip-only as the form to prefer when the viewer needs more than identity and
rank. It does.

Strip-only measures 607,191 bytes against lean's 379,566 on the production
corpus, both 25 to 40 times under the 4 MiB budget. This costs nothing that
matters, and it is the smaller diff: `degree` already lives in `topDegrees`, so
no read site changes.

The provenance fields stay **declared but optional** on the projection types
rather than removed outright, so a full `GraphNode` is still assignable wherever
a cached row is expected. `GraphQueryResult.nodes` carries stored rows
unprojected on the live path and had to keep type-checking. No consumer of
`GraphQueryResult` reads provenance off it (checked: the two provenance readers,
`cascade.ts` and `graph-retrieval.ts` via `graph-provenance.ts`, read stored
rows). Absence in a cached row is asserted at runtime instead, by fail-first test
two.

The viewer does not touch `sourceObservationIds` or `sourceBatchIds` anywhere.

## Fail-first, then pass

`test/graph-write-frame.test.ts`, run against `dd59718` before any source edit.
Three of the four failed. The fourth is recorded honestly as already passing.

**1. "keeps the snapshot write under the budget on a corpus that overflows the
row caps"** — FAILED on the parent:

```
AssertionError: expected 8031584 to be less than or equal to 4194304
```

(measured with the budget inlined as a literal, because `SNAPSHOT_BUDGET_BYTES`
does not exist on the parent). 8,031,584 bytes against a 4,194,304 budget.

**2. "caches snapshot rows that carry no observation ids"** — FAILED on the
parent:

```
AssertionError: expected { id: 'a', type: 'concept', …(4) } to not have
property "sourceObservationIds"
```

**3. "refuses an oversized value instead of dispatching it"** — FAILED on the
parent:

```
TypeError: guardedSet is not a function
```

**4. "does not rewrite the snapshot for a merge-only batch that mutates
nothing"** — **PASSED on the parent, unmodified.** The gate
`newNodeCount > 0 || newEdgeCount > 0 || snapMutated` already holds. R4 cost a
test and no code. The test is kept because it pins the gate against a future
edit, and it is mutation-checked below.

All four pass on `3137220`.

### Mutation checks

| mutation | result |
|---|---|
| `SNAPSHOT_BUDGET_BYTES` 4 MiB → 64 MiB | test 1 dies: `expected 67108864 to be 4194304` |
| remove `shrinkSnapshotToBudget(snap)` from the write path | test 1 dies: `expected 6064209 to be less than or equal to 4194304` |
| R4 gate → `if (true)` | test 4 dies: `expected [ { …(3) } ] to have a length of +0 but got 1` |
| reinstate cached-row sampling in `estimateScopeBytes` | the new enumeration-guard test dies: `expected [] to not deeply equal []` |
| write-path row size back to latest-wins | "never lowers the recorded row size" dies: `expected 179 to be 20000` |
| drop the `refused` counter from the ledger | "reports a refused write in the summary" dies: `expected +0 to be 1` |
| spread `snap.stats` back into `mem::graph-stats` | the stats-shape assertion dies: `to not have property "nodeRowBytes"` |

The first mutation is the one the plan asked for. It only bites because test 1
asserts against a **literal** 4 MiB, not against the imported constant: an
assertion that reads the constant raises its own threshold when the constant is
raised and can never fail. The constant's value is pinned separately.

The second mutation is the stronger one. It shows the byte assertion is
load-bearing rather than satisfied by the projection alone: with the projection
in place and the shrink removed, the write is 6,064,209 bytes, still over budget.
So commit `6e1889e` takes the payload from 8,031,584 to about 6,064,209, and
commit `740876d` closes the rest.

## The regression the plan did not list, and its fix

`checkGraphEnumerable` sized `mem:graph:nodes` and `mem:graph:edges` by sampling
`snap.topNodes` / `snap.topEdges` and taking `Math.max(sample_mean,
calibrated_floor)` (`graph.ts:215-229` on the parent). Commit `6e1889e` makes
those rows projections, so they stop being a stored-row sample:

| | per-row sample | estimate at `totalNodes` 8,468 | vs 52,428,800 budget |
|---|---|---|---|
| before | 28,372 B (14,186,233 / 500) | 240.3 MB | blocked |
| after, unfixed | 251.8 B, below the 4,481 floor → 4,481 | 37.9 MB | **fits, enumeration allowed** |

That is the enumeration `#814 v2` exists to refuse, the one that crashes the
worker on a `kv.list` frame.

**It is latent, not live, today.** `enumerable` is also gated on `!orphaned`, and
production's snapshot carries `resetAt: 2026-09-01T19:04:13.510Z` from the
failed-read bootstrap (visible in the tick-12 log line quoted in
`docs/investigations/2026-09-05-graph-write-frame-diagnosis.md:218`), so
`hasOrphanRows` forces the refusal regardless. A rebuild clears `resetAt`, and
then it would be live. Latent is still wrong, and it makes the guard permanently
less conservative for any future corpus.

Fix, in the same commit that causes it: the snapshot records the mean serialized
size of a **stored** row in `stats.nodeRowBytes` / `stats.edgeRowBytes`, and
`estimateScopeBytes` reads that instead of sampling cached rows. The measurement
is free on the write path, taken from the write ledger the diagnostic already
fills, and taken from a bounded 200-row sample on the rebuild path. Absent on a
pre-U1 snapshot, where the calibrated floors apply until the next write lands.

`test/graph-scope-enumeration.test.ts` gains a negative control, "does not size a
scope from the rows cached in the snapshot", and its existing fat-sample test now
sets `nodeRowBytes` instead of stuffing fat rows into `topNodes`.

## Plan claims corrected against the tree

The plan was written against production `878174f`. The branch is off `dd59718`,
which already carries the diagnostic.

1. **"Export `FRAME_LIMIT_BYTES` under its own name from `frame-guard.ts`. It is
   currently exported only as `FRAME_LIMIT_BYTES_FOR_TEST`."** Already done by
   `dd59718`, which exports it directly. No work.
2. **"`graph.ts` imports nothing from `frame-guard.ts`" (A.6).** True at
   `878174f`, false at `dd59718`, which imports `payloadByteLength` and
   `FRAME_LIMIT_BYTES` and routes ten of the fifteen writes through
   `measuredSet`. U1's step 1 shrank to: turn measurement into refusal, and route
   the remaining five (the `graph-batches` write, the three rebuild index
   backfills, and the `graph-reset` snapshot write). The 10 + 5 = 15 count
   matches the plan's "fifteen".
3. **"`src/mcp/server.ts` and `src/triggers/api.ts` both read
   `KV.graphSnapshot`" (D5).** `src/mcp/server.ts:1490` reads it and uses
   **`snapshot.stats` only**, so the row-shape change does not reach it.
   `src/triggers/api.ts` does **not** read the snapshot at all; it has no
   reference to `KV.graphSnapshot`. D5's "three other components read it" is
   really one, the viewer, plus a stats-only reader.
4. **The plan's file list undercounts the tests, as the plan itself warned.** The
   three it names (`graph.test.ts`, `graph-scope-enumeration.test.ts`,
   `graph-snapshot-bootstrap-orphan.test.ts`) needed no change for the row shape.
   Two files it does not name did: `graph-scope-enumeration.test.ts` for the
   enumeration-guard fix, and `graph-write-frame-diagnostic.test.ts`, whose
   fixtures depended on an oversized snapshot the byte bound now prevents.

### Unresolved: `topEdges` 2,454 versus 1,000

Plan A.5 censuses the on-disk `mem:graph:snapshot` file and reports `topEdges` at
**2,454** rows / 2,570,167 bytes, and step 4 of the approach is justified by it:
"Production's array is at 2,454 against a cap of 1,000."

The tick-12 production log line, quoted in the frame diagnosis at `:218` and
`:210`, reports `"topEdges":1000` on the snapshot that same process read and
tried to write, with `snapshotResetAt` proving the read succeeded rather than
bootstrapping.

Both are sourced observations and they disagree. Neither was dismissed. The
truncation shipped anyway: it is four lines, it is correct under either reading,
and `buildSnapshotFromArrays` genuinely applies no `topEdges` cap at all, which
is a real unbounded path regardless of what the current array holds.

**The sandbox proof settles it**: read `topEdges` from the first
`Graph delta persisted` line after boot, before any write lands. If it reads
2,454 the census is right and the truncation fires on load. If it reads 1,000 the
log is right and the truncation is dormant defence.

## Gates

| gate | result |
|---|---|
| `npx tsc --noEmit` | **29 errors, byte-identical to the `dd59718` baseline.** Diff of the normalised error lists is empty. |
| `npm run build` | **pass**, exit 0, 20 files / 3.19 MB. |
| `npm test` (full) | **not green.** 8 failures on the final run. Zero attributable to U1 (see Limitations 2). |
| graph-touching tests in isolation (11 files) | **144 passed, 0 failed** at `3137220`, and green on every run since. `graph-write-frame`, `graph-write-frame-diagnostic`, `graph`, `graph-scope-enumeration`, `graph-snapshot-bootstrap-orphan`, `graph-provenance-batch`, `graph-retrieval`, `graph-import`, `cascade`, `reflect`, `temporal-graph`. |

Baseline evidence for the `npm test` attribution:

- parent, quiet machine, before any edit: 4 failures / 2 files.
- parent, loaded machine, same session: 25 failures / 19 files.
- branch, loaded machine, run 1: 14 failures / 10 files. Branch-only: **0**.
- branch, loaded machine, run 2: 14 failures / 12 files. Branch-only: **0**.
- branch, final state, quieter machine: 8 failures / 6 files. Branch-only: **0**,
  graph-file failures: **0**. The 4-failure quiet baseline set is contained in it.

The failing set drifts run to run across the same non-graph files, which is the
flakiness `.claude/rules/pr-governance.md` already records for this tree.

## What the sandbox proof must read

Per the plan's U1 section. One `scripts/memory-loop/sample.sh` run on this branch
against the graph-on baseline at equal container age. The `dd59718` diagnostic is
retained on the branch so all of this is readable.

1. **Zero `Graph write over 8 MiB` lines carrying `overFrameLimit: true`.** A
   warn with `overFrameLimit: false` is fine and expected on a fat row; it is the
   frame crossing that must be gone.
2. **A new line to watch: `Graph write refused over the frame limit`.** Added by
   `260c55e`. Any occurrence means a write was refused rather than dispatched,
   which is a success for the guard and a failure for the bound, and it names the
   scope and key that did it. The `Graph delta persisted` summary carries a
   matching `refused` count, at the call level and per scope, so a refusal is
   also countable from the summary alone.
3. **`worker_registrations: 0`**, and specifically **zero re-registrations
   attributable to a graph `state::set`**: an `ECANCELED` within about one second
   after a warn line carrying `overFrameLimit: true`. Report the absolute count
   beside it as a diagnostic, not as the gate. The railway filter is in the
   plan's U1 section.
4. **`Graph delta persisted` lines:** `snapshotBytes` under 4,194,304, and
   `writeMs` in the single-digit seconds against 33,415 ms at tick 12.
5. **`topEdges` on the first `Graph delta persisted` line after boot**, which
   settles the 2,454-versus-1,000 question above.
6. **The per-extract engine step**, from the 30-second series around each
   `Graph delta persisted` line. Expected to shrink from 5.9 GB roughly by the
   tick ratio, **not to vanish**. Record whatever it is; A.7 predicts U1 moves
   this little and U2 is what removes it.
7. **`mem:graph:snapshot` on disk**, from 16,772,000 bytes to under 1 MB.
8. **Q4's free answer:** `snapshotTotalNodes` growth against the count of new
   rows in the same line. If they track, U1 closed the 4.4x undercount going
   forward.

**Expected once, at boot, and not a failure.** The first extract after deploy
still pulls the existing 16,772,000-byte snapshot inbound. The raw read at the
top of `persistGraphDelta` is unbounded, and it fits under the frame, which is
why reads work today while writes do not. That extract then writes the bounded
one. So the first `Graph delta persisted` line after deploy carries a large
inbound cost and a small `snapshotBytes`. From the second extract onward the
inbound cost is gone too. Do not read the first line as U1 not working.

Promotion gate, per the plan and KTD4: zero graph-attributable worker
re-registrations, `livez_ok: 1`, `recall_hit_rate_100 >= 0.54`, zero
`overFrameLimit` warns, and `cgroup_mib_peak` not worse than baseline by more
than 5%. **The peak-only 5% discard does not apply to U1.** Then the 2x at-scale
gate.

## Composition with U2

U1 and U2 both touch `src/functions/graph.ts`. U1 changes the write helper, the
snapshot builder, the snapshot row type, and the enumeration guard's sizing
input. U2 changes the merge branch and adds the rebuild. They do not overlap, but
`.claude/rules/pr-governance.md` wants the composition stated in both PR bodies,
so state it there.

One forward note for U2: `snap.stats.nodeRowBytes` is now what sizes the row
scopes for `checkGraphEnumerable`. U2's cap shrinks a stored row from ~7,176
bytes to ~236, so that measurement will fall by about 30x and the enumeration
guard will correctly become far less restrictive. That is U2 working, not U1
regressing, and it should be read as such when the guard starts allowing
enumerations it used to refuse.
