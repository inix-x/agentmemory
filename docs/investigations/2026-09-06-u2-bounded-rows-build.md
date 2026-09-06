---
title: "U2 build record: bounded node cost"
date: 2026-09-06
type: build
plan: docs/plans/2026-09-06-001-graph-memory-redesign-plan.md
branch: feat/u2-bounded-graph-rows
parent: d41fa2a
---

# U2 build record: bounded node cost

Five commits on `feat/u2-bounded-graph-rows`, branched off U3's head `d41fa2a`
so the cascade rewiring KTD5 requires is already in place. Code and tests only:
the one-time rewrite runs on the sandbox later. Not pushed, not deployed.

## Limitations, first

1. **The retire helper this step was supposed to extend is not in this
   branch's ancestry.** `retire_scope` lives on
   `feat/retire-orphaned-index-generations` (`1d6891d`), a sibling of this
   branch, not an ancestor. The task's WHERE pins the parent to
   `feat/u3-graph-index-write-path`, so the block here defines `retire_scope`
   itself behind a `command -v` guard. The two merge in either order and
   whichever lands second should drop its copy. This is stated rather than
   quietly duplicated.
2. **The retire-then-load ordering rests on observed behaviour, not on engine
   source.** The engine is a pinned binary whose source is not in this tree.
   The claim that a write to a retired scope re-creates it is the cold-start
   path: the sandbox's empty boot produced `state_store.db` with three files
   (`2026-09-05-sandbox-creation-record.md`, 11:09), and every one of
   production's other 2,722 scope files was minted by a first write. That is
   evidence, and it is strong, but the sandbox procedure below reads it back
   directly before the full sample rather than assuming it.
3. **No rewrite has been run on real data.** Every number below is arithmetic
   over the 09-05 census plus unit-test fixtures. Sample B is what settles it.
4. **`mem:graph:obs-index` sizing is still Q2's open item**, and the emitter
   inherits U3's answer: it stops at a pair ceiling rather than transposing all
   33,767,235 reachable pairs (about 902 MiB). A partial index is exact per
   observation, which is how every reader asks.
5. **The accepted retrieval regression from KTD2 is now live.** A row touched
   by more than `GRAPH_ROW_BATCH_CAP` extracts resolves only its most recent
   batches through `graph-retrieval.ts`, which uses that direction to dedupe
   and label. Cascade is exact regardless, via `obs-index`.
6. **The rewrite's backfill batch ids are longer than a minted one**, which
   makes the rewrite-time rows about 30 bytes larger than the plan's table
   says. Recomputed below. It does not move the gate.

## Commits

| hash | title | what it does |
|---|---|---|
| `ccb0d5b` | `feat(graph): decouple batch provenance from the LLM flag` | `batchMode` reads `GRAPH_PROVENANCE_MODE` alone. `extractGraphHeuristics` takes the batch id and stamps rows the way `parseGraphXml` already did. The batch row is written just before persist, so an empty extract leaves no orphan. |
| `82ac7b5` | `feat(graph): cap a row's batch provenance at GRAPH_ROW_BATCH_CAP` | `mergeNode` and `mergeEdge` keep the most recent 32 ids, oldest dropped, survivors' order intact. Read per call from config. |
| `e47717e` | `test(cascade): flag parity under legacy and batch provenance` | R6. A pin, and it passes on the parent. Compares flagged row identities and an absolute expected set, not only parity. |
| `dd555e1` | `feat(graph): offline rewrite tool for the graph row scopes` | `scripts/graph-rewrite/rewrite.py`. Census parser plus a writer; emits three JSON streams; refuses on a changed `resetAt`. |
| `0eab98f` | `feat(graph): load rewritten rows through the verbatim importer and swap at boot` | `mem::graph-rows-load` plus the entrypoint retirement, both on `GRAPH_ROWS_REWRITE_AT_BOOT`. Recomputes the three derived indexes. |

## The cap default, and why 32

`GRAPH_ROW_BATCH_CAP` defaults to 32 and is read per call, the same way
`getGraphProvenanceMode` is, so the ceiling is tunable without a redeploy.

The reasoning is KTD2's and the census supports it. A row measures 238 B for
everything except provenance: id, type, name, two ISO timestamps, `properties`
(30.1 B mean on nodes, 2.0 B on edges), and the field names. `aliases` is empty
on all 149,467 node records. A minted batch id is `generateId("gb")`, about 24
characters, so 27 B inside the array. 32 of them is 864 B, and a row lands near
1.1 KiB, which is the task's own "O(1 KiB) in the hot scopes".

A row only reaches the ceiling if 32 or more separate extracts touch it. The p50
of 25 observation ids per node says that is a hub property rather than a typical
one.

## Expected on-disk size, recomputed

The plan's table with my own arithmetic beside it. Base row 238 B from A.2's
remainder; `"sourceObservationIds":[],` is 25 B; a batch-id array is 18 B plus
27 B per minted id.

| scope | plan, at rewrite | recomputed, at rewrite | plan, ceiling at 32 | recomputed, ceiling |
|---|---|---|---|---|
| `mem:graph:nodes` (37,039 rows) | 9.3 MiB (264 B) | **10.4 MiB** (295 B) | 40 MiB (1,132 B) | **40.4 MiB** (1,145 B) |
| `mem:graph:edges` (73,835 rows) | 19.0 MiB (270 B) | **21.2 MiB** (301 B) | 80 MiB (1,138 B) | **81.0 MiB** (1,151 B) |
| two row scopes | 28.3 MiB | **31.6 MiB** | about 120 MiB | **121.4 MiB** |

The ceiling reproduces the plan's numbers within 1%. The rewrite-time figures
come out about 11% high, for one reason: the emitter's backfill ids read
`gb_backfill_nodes_<stamp>_<n>`, 36 characters against a minted id's 24, so each
row's single reference costs 57 B rather than 26 B. It is a naming choice, not a
mechanism, and both figures sit far under the gate's 64 MiB for all six scopes.

A row carries at most two backfill ids at production's size: the emitter chunks
distinct observation ids at 200,000 per batch row and there are 306,791 of them,
so a row whose observations span both chunks holds two. Worst case at rewrite is
352 B, not 1.1 KiB. The ceiling column is steady state, reached only after 32
post-rewrite extracts touch the same row.

Against 2,039.5 MiB today, 31.6 MiB is a **64x reduction** at rewrite and the
ceiling holds it under 122 MiB whatever the touch rate does.

## Fail-then-pass

**`ccb0d5b`** — three tests, run against `d41fa2a`:

```
× heuristic-only extraction writes batch provenance when the mode is batch
  AssertionError: expected [] to have a length of 1 but got +0
```

`batchMode` was false because `llmEnabled` was false, so the row took the legacy
branch and no batch row was written. That is the shape of the census finding:
`sourceBatchIds` empty on all 424,339 production records.

**`82ac7b5`** — three tests, run against the parent:

```
× stops growing with batch size
× keeps the most recent GRAPH_ROW_BATCH_CAP ids, in order, under 1.5 KiB
× caps an edge row the same way
  AssertionError: expected [ 'gb_2', 'gb_3' ] to deeply equal [ 'gb_1', 'gb_2', 'gb_3' ]
```

**`e47717e`** — **passes against the parent, unmodified.** It is a regression
pin, and the fail-first record stays honest by saying so. Cascade reads
`obs-index` since U3, and `persistGraphDelta` writes that index from the
extraction event in both modes, so neither the provenance shape nor the cap can
reach the flagging. Verified against the true parent source, not against a
stash that turned out to be empty.

**`dd555e1`** — six tests, run with the tool absent: all six fail on
`ENOENT`/`Command failed`.

**`0eab98f`** — four tests. The loader is new, so they fail on the missing
module; the entrypoint assertion fails on the absent flag.

### Mutation checks

| mutation | result |
|---|---|
| re-couple `batchMode` to `isGraphExtractionEnabled()` (the plan's named check) | test one dies: `expected [] to have a length of 1` |
| `GRAPH_ROW_BATCH_CAP_DEFAULT` 32 → 64 (the plan's named check) | cap tests die: `expected 64 to be 32` |
| keep the oldest batch ids instead of the newest | `expected [ 'gb_0', … ] to deeply equal [ 'gb_10', … ]` |
| truncate cascade's `obs-index` read | parity survives; the **absolute** assertion dies |
| rewrite split `<` → `<=` (drops the row stamped exactly at reset) | `expected 2 to be 3` |
| drop the emitter's D2 refusal | `expected [Function] to throw an error` |
| skip the loader's name-index recompute | the derived-index test dies |
| drop the flag from one entrypoint | drift test dies on three assertions |

Two of these are worth naming. The cap-literal mutation only bites because the
test asserts against a literal 32 with the constant pinned separately; an
assertion derived from the constant raises its own expectation and can never
fail. And the parity pin needed an absolute expectation added, because a
mutation that under-flags **both** modes equally leaves parity intact — the
first version of that test survived exactly such a mutation.

## Gates

| gate | result |
|---|---|
| `npx tsc --noEmit` | **29 errors, identical to the `d41fa2a` baseline.** Normalised diff empty, checked after every commit. |
| `npm run build` | **pass**, exit 0. |
| `npm test` | **green. 187 files, 2,036 tests, 0 failures.** |

The parent run in the same session had 4 failures
(`antigravity-connect-hooks`, `copilot-plugin`, `hook-project`,
`observe-dedup-prompt`) — the loaded-machine flaky set
`.claude/rules/pr-governance.md` records. The branch run had none, which is the
same set behaving differently under lighter load rather than anything this
branch fixed.

## The sandbox procedure

### Sample A, code only

Isolates the write-path change from the rewrite. The 2 GB of legacy rows is
still what the save loop clones, so peak should be roughly flat; that is the
control, not a disappointment.

1. Deploy this branch with `GRAPH_PROVENANCE_MODE=batch` and no rewrite flag.
   Leave `GRAPH_EXTRACTION_ENABLED` as production has it, off — that is the
   configuration the decoupling exists for.
2. `GET /agentmemory/diagnostics/store`, record `byScope` for the six graph
   scopes and `k` at boot.
3. Drive one session-end extract. On the `Graph delta persisted` line confirm
   `index` counts non-zero and `refused: 0`.
4. Read one freshly written node row and assert `sourceBatchIds` has length 1
   and `sourceObservationIds` is empty. **This is the assertion sample A
   exists for**: it is the first time in this corpus's history that a row
   carries batch provenance.
5. Full `scripts/memory-loop/sample.sh`. Record `cgroup_mib_peak`,
   `worker_registrations`, and the engine RSS step across each
   `Graph delta persisted` line.

### Sample B, code plus rewrite

1. **Census first, and record the stamp.** Read `resetAt` from the live
   snapshot and keep it; the emitter is given it as `--expect-reset-at` and
   refuses if it moved (D2).
2. Run the emitter offline against a copy of the volume, once per scope:

   ```
   python3 scripts/graph-rewrite/rewrite.py \
     --scope nodes --bin <copy>/mem%3Agraph%3Anodes.bin \
     --snapshot <copy>/mem%3Agraph%3Asnapshot.bin \
     --out <emit-dir> --expect-reset-at <recorded>
   python3 scripts/graph-rewrite/rewrite.py \
     --scope edges --bin <copy>/mem%3Agraph%3Aedges.bin \
     --snapshot <copy>/mem%3Agraph%3Asnapshot.bin \
     --out <emit-dir> --expect-reset-at <recorded>
   ```

   Expect `kept` 37,039 and 73,835 against `dropped` 112,428 and 201,037. A
   different split means the stamp or the copy is not the one the census read.
3. **Round-trip before loading** (D4): feed each `rows.json` back through the
   parser and compare record counts and ids. The test does this on a fixture;
   do it on the real output too, because that is what D4 asks for.
4. Upload `<emit-dir>` to the volume.
5. **Verify the ordering assumption before relying on it** (Limitation 2). Set
   `GRAPH_ROWS_REWRITE_AT_BOOT=<dir>` and deploy. In the boot log expect six
   `agentmemory: retired mem%3Agraph%3A….bin, <bytes>` lines, then
   `Graph rows rewrite: loading from <dir>`, then
   `Graph rows loaded from rewrite` with the counts. If the load reports zero
   or errors on the first row, the write-to-absent-scope assumption is wrong
   and the design needs the load to pre-create the scopes instead.
6. `GET /agentmemory/diagnostics/store` **immediately after boot**. Expect the
   six graph scopes under 64 MiB, against about 52 MiB projected. Record
   `byScope`.
7. Full sample. Then read `byScope` again and confirm the two row scopes grew
   by less than 5 MiB over the window, and that no row's `sourceBatchIds`
   exceeds 32. That second check is what the size table exists for: the first
   number is rewrite-time, and only the steady-state one holds for a week.
8. The 2x at-scale gate:
   `node scripts/memory-loop/replay.mjs --until-disk-mib 7020` then
   `sample.sh`, with `cgroup_mib_peak` under 8,192 MiB.

The originals are in `/data/retired/<stamp>/`. Nothing was deleted, so the
whole step is reversed by moving six files back and clearing the flag.

## Composition with U1 and U3

**U1** gave every graph write a frame guard. The loader writes through
`graphWriter`, so each of the roughly 110,874 row writes is sized before it is
dispatched, and the emitter chunks its backfill batch specifically so no single
row rebuilds the unbounded-array shape U1 removed.

**U3 is this branch's parent, and KTD5 is satisfied rather than argued.** The
cap drops old batch ids, which would have made cascade's membership test
silently inexact — under-flagging on exactly the hub rows that matter most.
U3 moved cascade to `mem:graph:obs-index`, which does not read row provenance
at all, so the cap cannot reach it. `e47717e` is the pin on that.

U3's `mem::graph-index-backfill` and this rewrite overlap and should not both
run. The rewrite emits `obs-index` directly, so after a successful sample B
the backfill has nothing to add for the rewritten rows; run it only if the
rewrite is skipped.

One forward note. U3's build record measured `obs-index` at roughly 21.8M pairs
and 545 MB in steady state and proposed a batch-indirection variant that cuts it
about 9x. This branch does not change that. If the variant lands, the emitter's
`obs-index` stream is the other place it has to change, and the pair ceiling
here becomes unnecessary rather than merely bounded.
