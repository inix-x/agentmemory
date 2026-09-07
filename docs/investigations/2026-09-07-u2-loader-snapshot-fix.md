# U2 loader: restore the snapshot, and what the guard still refuses on

Date: 2026-09-07. Branch `feat/u2-bounded-graph-rows`, commit `c0794ce`.
Closes the loader defect P1 recorded in
`docs/investigations/2026-09-06-graph-rewrite-prototype.md:89`.

## The defect

`deploy/*/entrypoint.sh` retires `mem:graph:snapshot` along with the other five
graph scopes before the engine starts. `mem::graph-rows-load` restored the rows,
the batches, the obs-index, and the three derived indexes, but never the
snapshot. So `readSnapshot` returned null, `checkGraphEnumerable` read
`totalNodes` as null, and it refused before the byte check.

The refusal was correct as a fail-closed, and it reported a missing measurement
rather than a decision about the corpus. It also does not last, which is the
part the prototype doc did not reach. See the next section.

## The defect re-opens a documented outage mechanism, measured on the sandbox

The fail-closed only lasts until the first extract. `persistGraphDelta` reads
the snapshot raw and, finding it absent, bootstraps an empty one
(`src/functions/graph.ts:1110-1114`). That snapshot counts the rows that
extract touched, carries no `resetAt`, and overwrites nothing because nothing
was there. The guard then sizes a corpus of tens of thousands of rows from a
count in the low hundreds, and opens.

The comment directly above that code names this as the cause of a production
outage: an unmarked empty snapshot let "a 414 MB graph scope look enumerable",
retrieval enumerated the whole scope, the frame passed the websocket 100 MiB
`maxPayload`, and the worker died in a loop. The fix distinguished a FAILED
snapshot read, which stamps `resetAt` and stays closed, from a genuinely ABSENT
one, described as "a cold start with nothing on disk".

The boot swap breaks that second assumption. The entrypoint retires
`mem:graph:snapshot` while the loader restores every other scope, so the
snapshot is absent with a full corpus on disk. That case is neither of the two
the dichotomy covers.

Measured on the sandbox, which ran the swap at 02:16Z on 2026-09-07:

| observation | value |
|---|---|
| rows the loader wrote at 02:17:37Z | 37,066 nodes, 77,980 edges |
| `snapshotTotalNodes` after extracts, 02:36:56Z | 121 |
| graph enumeration refusals in the retained sandbox log | 0 |
| graph enumeration refusals on production, same window | 34 |

Both stores run the same `mem::reflect` cycle, and the sandbox refuses
`mem:semantic` eight times in that log while refusing the graph not once.
Production, which has never run the swap, refuses the graph on every cycle. The
sandbox's guard is open over a corpus 306 times larger than its snapshot
claims.

The consequence on that particular store is bounded, and saying so is part of
the finding. U2's own rewrite made the rows small: the sandbox's write ledger
reports `maxBytes` of 489 for a node and 369 for an edge, so enumerating all
115,046 rows is tens of megabytes, under the 100 MiB payload ceiling. No
re-registration appears in the log. The safety property is broken; this store
happens to survive it because the unit that broke it also shrank the rows.

Production is unaffected. It does not run the swap, its snapshot is continuous,
and its guard refuses correctly.

## The fix

`buildSnapshotFromArrays` already produced exactly the needed shape, so the
loader reuses it rather than assembling a snapshot by hand. Two properties
matter.

**Written last.** Every row write precedes it. A load that throws part way
leaves no snapshot at all, rather than one naming counts that no row on disk
backs. `checkGraphEnumerable` sizes both scopes as `total * per-row`, so a
snapshot that outlives a failed load would size a corpus that never landed.

**`resetAt` is not carried across.** The emitter drops every pre-`resetAt` row,
so the orphan condition the retired snapshot recorded is resolved by the
rewrite itself. Carrying it would leave `hasOrphanRows()` true and hold the
guard shut for a reason that no longer exists.

Tests are in `test/graph-rows-load.test.ts`. The new case fails against the
unmodified loader. Two mutations were checked and each kills a test: carrying
`resetAt` kills the snapshot case, and moving the write ahead of the rows kills
the refusal case.

## What this does NOT do: the guard stays shut, on edge bytes

The loop prompt's line 198 asks for "one sandbox boot that shows the guard
open". That bar is not reachable, on either store, and the reason differs
between them. Read `SAFE_ENUMERATION_BYTE_BUDGET` = 50 MiB,
`CALIBRATED_BYTES_PER_NODE` = 4,481, `CALIBRATED_BYTES_PER_EDGE` = 3,036,
`SAFE_ENUMERATION_NODE_CEILING` = 25,000.

| store | nodes | edges | node ceiling | node bytes | edge bytes | enumerable |
|---|---|---|---|---|---|---|
| production, live 11:03Z | 9,546 | 21,829 | pass | 40.8 MiB, fits | 63.2 MiB, over | false |
| sandbox, prototype doc | 37,066 | 77,980 | fail | 158.4 MiB, over | 225.8 MiB, over | false |

Production passes the node ceiling that the sandbox fails, so the sandbox
cannot answer the production question. Production is refused on edge bytes
alone. Only 17,269 edges fit the budget at the calibrated floor, and production
holds 21,829.

The rewrite cannot move that number. `estimateScopeBytes` at
`src/functions/graph.ts:316` computes
`Math.max(measuredPerRow ?? 0, calibratedFloor)`, so the floor is a hard lower
bound rather than a fallback. However small the rewrite makes a stored edge
row, the guard still sizes it at 3,036 bytes.

This is not a blocker for the plan. U3's read path replaces the enumerating
read path entirely, and its gate stubs `kv.list` to throw on both graph scopes,
so retrieval stops depending on the guard opening at all.

It is worth a separate look, because the floor's stated purpose and its
behaviour differ. `src/types.ts:551` describes the floors as covering a
snapshot where the measurement is "absent on a pre-U1 snapshot ... until the
next write lands". The `?? 0` already covers absence. The `Math.max` additionally
overrides a measurement that IS present and smaller, which is the case U2
creates. Whether that conservatism is intended is a decision for whoever takes
U3's read path, not a change to make under U2.

## The snapshot the loader writes is frame-safe at scale, measured

The loader hands the whole corpus to `buildSnapshotFromArrays` in one call,
which no other caller does, so the frame question was measured rather than
reasoned. At 40,000 nodes and 80,000 edges, above both stores:

| quantity | value |
|---|---|
| serialized snapshot | 90,514 B |
| `SNAPSHOT_BUDGET_BYTES` | 4,194,304 B |
| `topNodes` after the cap | 500 |
| `topEdges` after the cap | 144 |
| measured `nodeRowBytes` | 159 |
| measured `edgeRowBytes` | 157 |

88 KB against a 4 MiB budget, and far under the 16 MiB frame. The old 16.7 MB
snapshot predates U1's projections. The cap at `SNAPSHOT_TOP_NODES` = 500 and
`SNAPSHOT_TOP_EDGES` = 1,000 makes this invariant in corpus size, so it is
recorded here rather than added as a standing test that would re-cover
`graph-write-frame.test.ts`.

The last two rows restate the section above in measured terms. The rewritten
rows measure 159 and 157 bytes, against calibrated floors of 4,481 and 3,036.
`Math.max` discards both measurements. The floor the guard uses for an edge is
19 times the row the rewrite actually produces.

## Bar this unit actually closes

The snapshot scope exists after the swap. `totalNodes` and `totalEdges` are
non-null and equal the loaded row counts. `nodeRowBytes` and `edgeRowBytes` are
measured from stored rows. `resetAt` is absent. The guard's refusal becomes a
corpus-size decision carrying real numbers instead of "no graph snapshot
exists".

The plan's own U2 gate is unchanged and untouched by this fix: six graph scopes
under 64 MiB, per-extract step under 200 MiB, originals retired under
`/data/retired/<stamp>/`. Recall belongs to U3's read path.

## Gates

`npm test` green at 2,038 passed, 1 skipped, 187 files. `tsc --noEmit
--incremental false` holds at 29 errors, measured by reverting the three files
to HEAD rather than assumed. `npm run build` succeeds.

One full-suite run before this one failed five mesh cases on 5,000 ms timeouts.
The same suite at the base failed a different case, `copilot-plugin`, and the
mesh file passes in isolation at 32 of 32. That is the host's documented
load-sensitivity, reproduced at the base, not a regression from this change.
