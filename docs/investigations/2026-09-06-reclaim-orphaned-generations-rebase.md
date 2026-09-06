# Rebasing `fix/1115-reclaim-orphaned-index-generations` onto `origin/production`

Date: 2026-09-06
Task: T14. Rebase the branch and evaluate it as the next memory lever after the
graph units.
Worktree: `/private/tmp/claude-501/-Users-ogerardo-src-agentmemory/d60174a6-eeba-4749-9672-507865d9fd3c/scratchpad/wt-reclaim`
Branch: `fix/reclaim-orphaned-index-generations-rebased`
Base: `origin/production` = `878174fb4a21ca4f9318c89c9e4ab2d247e9d4d5`
Not pushed. Not deployed. No tracked file in the main tree was modified.
This document is a new **untracked** file in the main tree. `docs/` is excluded
at `.git/info/exclude:20`, so it does not appear in `git status` and needs
`git add -f` to commit.

## Headline

**The reclaim already shipped. This branch is not a memory lever.**

The commit the lever was named for, `bbb49d3`, is byte-identical to
`6a27bca` on `origin/production` and has been there since 2026-08-26. What
remains unlanded is nine lines of save coalescing that touch nothing in the
reclaim path. On the 2026-09-05 store this branch reclaims **0 MiB**.

The 306.8 MiB is still worth taking. It needs a different change, sized at the
end of this document.

## 1. Commits kept and dropped

`origin/production..origin/fix/1115-reclaim-orphaned-index-generations` is four
commits, not the three the task named.

| Commit | Subject | Decision |
|---|---|---|
| `e04ba88` | `fix(cli): make fresh installs portable and persistent (#892)` | **dropped** |
| `bbb49d3` | `fix(state): reclaim index generations the manifest can no longer name` | **dropped** |
| `c6851e7` | `fix(state): coalesce onto a queued save so a delete does not wait out the line` | kept, now `9f66ac1` |
| `81127a6` | `refactor(state): name the coalescing field for the invariant it holds` | kept, now `73a1883` |

### `e04ba88` dropped: upstream drift production never took

Authored by Rohit Ghumare, 2026-08-23, upstream PR #892. It is the parent of
`bbb49d3`, so the branch inherited it rather than choosing it. Production does
not have it and does not have its files:

```
$ git ls-tree origin/production -- src/cli/engine-launch.ts src/cli/engine-config.ts src/runtime-paths.ts
(empty)
$ git merge-base --is-ancestor e04ba88 origin/production
NO
```

Replaying it would reintroduce 2,651 lines across 28 files, a whole CLI
launch subsystem production has diverged from. It is not our change and it is
not in scope for a reclaim branch.

### `bbb49d3` dropped: already in production, byte for byte

```
$ git merge-base --is-ancestor 6a27bca origin/production
YES
$ git diff --quiet bbb49d3 6a27bca -- src/state/index-persistence.ts test/index-persistence.test.ts
IDENTICAL: bbb49d3 and 6a27bca trees match on both files
```

`6a27bca` carries the same subject line and the same content for both files it
touches. Production also carries the follow-up `20b1a24`, `docs(state): drop
the review marker from the gc ledger append`. Replaying `bbb49d3` would be a
no-op at best and a conflict at worst.

This is why the composition doc's line 99, "`fix/1115-reclaim-orphaned-index-generations`
exists as a branch and is not on `production`", is true of the branch ref and
false of the code on it. The branch ref never landed. Its reclaim commit did.

### `c6851e7` and `81127a6` kept

These are the only unlanded work. `git rebase --onto origin/production bbb49d3`
replayed both with **no conflicts**.

`81127a6` came through as `73a1883` at `-19/+4` instead of its original
`-24/+4`. Production's `20b1a24` had already removed five lines of the same
comment block, independently. That is the expected outcome, not a mis-resolve.

## 2. Net change against production

One file, nine insertions, one deletion, in `save()`:

```ts
  private unstartedSave: Promise<void> | null = null;
  ...
  async save(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.unstartedSave) return this.unstartedSave;

    const pending = this.enqueue(() => {
      if (this.unstartedSave === pending) this.unstartedSave = null;
      return this.runSave();
    });
    this.unstartedSave = pending;
    return pending;
  }
```

It touches `save()` and nothing else. `reclaimGenerations`, `recordGeneration`,
`trackGeneration`, `untrackGeneration`, and `readLedger` are unchanged from
production. **The branch cannot change which generations get discovered or
reclaimed.** That is a structural fact about the diff and does not depend on
resolving anything about the store.

One caveat a reviewer would find, so it is stated here. Discovery logic is
untouched, but `reclaimGenerations` has two call sites and one of them is in
the save path:

```
356:      await this.reclaimGenerations(manifestKey, generation);      // saveShardedIndex, after publish
723:        .enqueue(() => this.reclaimGenerations(manifestKey, live))  // load path
```

Every save cycle carries a reclaim attempt, so collapsing six flushes into one
running plus one queued lowers the number of reclaim retries per unit time. If
the non-convergence in section 3 turns out to be retry starvation on stranded
shards, this commit points the wrong way for the problem the branch was named
for. It does not change the 0 MiB verdict, which rests on discovery being
unchanged, and the coalescing is still correct on its own terms: a queued save
that has not started will serialise the index as it stands when it runs.

## 3. What this code would reclaim on the 2026-09-05 store

### The generations on disk

From `docs/investigations/2026-09-05-phaseA-close-store-diagnostics.json`
(`at` 2026-09-05T07:05:57Z, `/data/state_store.db`, 3,680,744,036 bytes total).
Generation ids are base36 milliseconds, decoded below.

| Generation | Minted (UTC) | Files on disk | Bytes | MiB | Role |
|---|---|---|---|---|---|
| `idx_mtnp1c9s_3698dd9cd6e0` (bm25) | 2026-09-05 01:17:52.864 | 227 | 497,323,484 | 474.3 | **live**, this boot |
| `idx_mtj0pzb2_73ee689c0219` (bm25) | 2026-09-01 18:46:07.358 | 76 | 165,425,164 | 157.8 | orphan |
| `idx_mtlwdg4b_4d6f0fb52cfe` (bm25) | 2026-09-03 19:07:42.683 | 72 | 156,302,108 | 149.1 | orphan |
| `idx_mtnp1k57_...` (vectors) | 2026-09-05 01:18:03.067 | 29 | 57,311,888 | 54.7 | **live**, this boot |

Orphan total: **321,727,272 bytes, 306.8 MiB, 148 files.** That reproduces the
composition doc's 307 MiB across 148 files exactly.

`docs/investigations/2026-09-05-sandbox-store-diagnostics.json` (2026-09-05
11:47Z) reports the same four generations at the same byte counts, which is the
expected result for a byte-faithful copy.

### The answer

**The rebased code reclaims nothing it is not already reclaiming, so 0 MiB.**
The two orphans survived under production's own reclaim code, and the retained
delta does not touch discovery.

The code keeps the live generation named by the manifest, `idx_mtnp1c9s_...`
at 474.3 MiB, plus the live vector generation at 54.7 MiB.

### Why the orphans survived, as far as the disk can say

The reclaim mechanism is not dark on this store. Three things are on the record.

**One. The deployed image had the ledger at the 2026-09-05 boot.** The
composition doc reports a `generation_reclaim` audit row evicting 29 files at
01:18:04Z. That action string exists only in the ledger code. Behavior, not a
commit date, proves the deployment.

**Two. That sweep was the vector index, not BM25.** 29 files is exactly the
shard count of the live vector generation `idx_mtnp1k57_...`, minted 01:18:03Z,
one second earlier. A vector reclaim that evicted its predecessor and left one
live generation fits. `reclaimGenerations` emits no audit row when it reclaims
nothing, so a BM25 sweep that found nothing would be silent. The audit row
carries `manifestKey` and would settle this outright; no raw rows are committed
to this repo, so the shard-count match is a strong argument and not a proof.

**Three. Both BM25 orphans are partially reclaimed remnants, not untouched
generations.** `largestFiles` names the surviving shards individually. Highest
surviving shard index against surviving file count:

| Generation | Highest index seen in the `largestFiles` top-50 sample | Files surviving | Shards gone (at least) |
|---|---|---|---|
| `idx_mtnp1c9s_...` (live) | 222 | 227 | 0, the set is complete |
| `idx_mtlwdg4b_...` | 220 | 72 | ~149 |
| `idx_mtj0pzb2_...` | 165 | 76 | ~90 |

The index column is sampled, not exhaustive: `largestFiles` holds the 50 biggest
files, so the true maximum is at or above what is shown, and "shards gone" is a
floor. That is why the live row reads 222 against 227 files.

A generation that was written with at least 221 shards and holds 72 lost the
rest to a bulk delete. The live generation shows the contrast: 227 files with a highest
index of 222, a complete set. So something deleted most of both orphans and
stopped. This is the composition doc's "reclaim runs but does not finish",
confirmed from the file names rather than from the count.

**What the disk cannot say.** Whether the deleter was `reclaimGenerations` or
the `shard_write_rollback` path is not distinguishable from file names alone.
Both leave the ledger entry in place holding the stranded shards, and both are
retried on the next save and the next load. The open question is not "can the
code name these" but "why does its retry not converge across boots". The
`failed` field on the reclaim audit row answers it. That field is not in this
repo.

**The asymmetry is the finding.** In one boot, reclaim worked on the vector
manifest and left one live generation. On the BM25 manifest it left 306.8 MiB
of half-deleted remnants. The mechanism works; the BM25 side specifically is
not converging. Whoever writes the follow-up gets a targeted problem instead of
a speculative one.

### Resident cost

306.8 MiB on disk, at exp-001 sample 1's k of 2.86, is **~878 MiB resident**.
The composition doc's ~1.5 GB uses the whole-store k of 4.8 from the production
read. Both are in the docs; they differ because k is a whole-store average and
the two reads are of different stores.

## 4. Fail-first, pass, mutation

### `9f66ac1` (`c6851e7`), fail-first against its parent

The commit adds one test. Parent is `origin/production`. Running the new test
with `src/state/index-persistence.ts` reverted to production:

```
 FAIL  test/index-persistence.test.ts > IndexPersistence save coalescing > does not queue a second identical save behind one that has not started
AssertionError: expected 6 to be less than or equal to 2
 ❯ test/index-persistence.test.ts:1219:28
    1219|     expect(manifestWrites).toBeLessThanOrEqual(2);
       |                            ^

 Test Files  1 failed (1)
      Tests  1 failed | 39 skipped (40)
```

Six serialised saves, which is the regression the test names. With the commit's
source restored:

```
 Test Files  1 passed (1)
      Tests  40 passed (40)
```

### `73a1883` (`81127a6`), no fail-first

A pure rename of one field with no test changes. There is no behavior to fail
first on, so none was manufactured. It is covered by the same 40 tests.

### Mutation check on the reclaim assertion

The reclaim commit is dropped, so this checks **production's shipped
mechanism**, which is what this document reports on. Making
`reclaimGenerations` return before reading the ledger:

```
     × reclaims the previous generation when the previous manifest read fails (#1115)
     × reclaims a generation stranded by a failed cleanup on the next load (#1115)
     × reclaims the previous vector generation when the vector manifest read fails (#1115)
     × reclaims a pre-ledger manifest that carries no generation (#1115)
     × still reclaims when the gc ledger holds a malformed entry (#1115)
      Tests  5 failed | 35 passed (40)
```

Five tests die. The assertions are load-bearing. Source restored via
`git checkout HEAD --` afterwards.

## 5. Gates

### `npm test`

`npm test`, not bare `vitest run`, so `test/integration.test.ts` stays excluded.

| Run | Result |
|---|---|
| branch, run 1 | 18 failed, 1967 passed, 1 skipped (1986) |
| `origin/production`, run 1 | 18 failed, 1966 passed, 1 skipped (1985) |
| branch, run 2 | 19 failed, 1966 passed, 1 skipped (1986) |

The +1 total on the branch is the new coalescing test.

The failure sets differ between runs in both directions, and every failure is a
5,000 ms timeout in a file unrelated to this change. `test/index-persistence.test.ts`
did not fail in any of the three runs.

Pre-existing status was proven rather than assumed. Four files failed on the
branch but not on production's run: `auto-forget`, `hook-project`,
`search-index`, `session-end-transcript`. Running that identical four-file set
on each worktree back to back:

```
production:  Test Files  4 passed (4)   Tests  39 passed (39)
branch:      Test Files  4 passed (4)   Tests  39 passed (39)
```

Both pass under the same conditions, so the asymmetry is machine load and not
the change. `hook-project` is on the known-flaky list in
`.claude/rules/pr-governance.md`. Two files, `evict` and `retention`, failed on
production and not on the branch, which is the same effect in the other
direction.

### `npx tsc --noEmit`

Baseline measured by running it on `origin/production` in a separate worktree
rather than assuming the number.

```
production: 29 errors
branch:     29 errors
diff of the two error lists: empty
```

### `npm run build`

```
✔ Build complete in 142725ms
20 files, total: 3.17 MB
BUILD EXIT=0
```

## 6. Safety: the shipped reclaim deletes, it does not move

The task's bar is that reclaim moves to `/data/retired/<stamp>/` and never
deletes, as exp-001's `retire_scope` does. **The existing mechanism is not
equivalent.**

`reclaimGenerations` calls `this.kv.delete(shard.scope, shard.key)` in-process
at runtime. The delete is real and irreversible. exp-001's helper
(`exp/001-graph-off-retire`, `6851311`, `deploy/*/entrypoint.sh`) does this
instead:

```sh
_dest="$DATA_DIR/retired/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$_dest" || return 0
if mv "$_f" "$_dest/" 2>/dev/null; then ...
```

It runs before the engine starts, so the engine never sees a file mid-move, and
every retirement is undone with one `mv` back.

Two things follow, and they matter in this order.

**This gap is in shipped production code, not in the rebase delta.** The
delete landed on 2026-08-26 with `6a27bca`. The two commits kept here add no
delete. Converting reclaim from delete to move is a separate change against
production, on its own branch, with its own review.

**It was not built here.** It cannot be tested against this store locally, and
it is outside a rebase task's scope. It is filed as a recommendation.

## 7. Sandbox environment changes

None. Nothing was deployed, nothing was pushed, no sandbox variable was
touched, and the main tree's checkout was not modified. All work happened in
two scratch worktrees with `node_modules` symlinked to the main checkout.

## 8. What would actually take the 306.8 MiB

Not built. Sized only, so the decision stays with whoever plans the next unit.

The engine writes one file per scope and percent-encodes the colons, which is
what makes the boot-time retire path work at all. The orphan shards are named
on disk today:

```
mem%3Aindex%3Abm25%3Abm25%3Aidx_mtj0pzb2_73ee689c0219%3A00000.bin ... (76 files)
mem%3Aindex%3Abm25%3Abm25%3Aidx_mtlwdg4b_4d6f0fb52cfe%3A00000.bin ... (72 files)
```

Adding those two generation prefixes to `retire_matching_file` in
`deploy/*/entrypoint.sh` moves 148 files, 306.8 MiB, into
`/data/retired/<stamp>/` at boot. It is reversible with one `mv` per file, it
runs before the engine starts, and it needs no engine change. The generation
ids are pinned to this store, so it is a one-shot, which is what
`bbb49d3`'s own commit message called for: "The ledger cannot discover
generations orphaned before it existed; those need a one-time reclaim."

The durable fix is separate and is the real question this investigation
surfaced: make the BM25 reclaim retry converge. Start from the `failed` count on
the `generation_reclaim` audit row in production.

## 9. Limitations

- **The ledger contents were never read.** The diagnostics JSON reports bytes
  per scope. The gc ledger lives inside `mem:index:bm25` (44,092 bytes, one
  file) alongside the manifests, and its contents are not in this repo. Every
  claim here about which generations the ledger names is inference from disk
  shape, and is labelled as such.
- **No `generation_reclaim` audit row is committed to this repo.** Only the
  composition doc's summary of one. Its `manifestKey`, `liveGeneration`, and
  `failed` fields would settle the BM25-versus-vector question and the
  non-convergence question directly.
- **The ledger's deployment date is not established.** The audit row proves the
  code was deployed at the 2026-09-05 boot. Whether it was deployed before the
  orphans were minted on 09-01 and 09-03 is not proven from anything committed
  here. The partial-deletion evidence in section 3 makes it likely, since
  something deleted most of both, but "likely" is the right word.
- **`shard_write_rollback` versus `reclaimGenerations`** cannot be told apart
  from file names.
- **The k factors are whole-store averages.** 878 MiB (k 2.86) and 1.5 GB
  (k 4.8) bracket the resident saving. The ±15% caveat in the composition doc
  applies.
- **`npm test` is not green on either side.** 18 to 19 timeout failures in
  unrelated files on both the branch and production. Proven equivalent, not
  proven absent.
- **Nothing was deployed.** The 0 MiB verdict is from the code diff and the
  committed store reads, not from a boot of the rebased branch.

---

## boot-time index generation retire

Commit `1d6891d`, `feat(retire): retire index generations the manifest does not
name as live`, on `feat/retire-orphaned-index-generations`, branched from
`exp/001b-retire-writer-on` (`229ee30`).
Worktree: `/private/tmp/claude-501/-Users-ogerardo-src-agentmemory/d60174a6-eeba-4749-9672-507865d9fd3c/scratchpad/wt-retire-idx`
Not pushed. Not deployed. No tracked file in the main tree was modified; this
section is appended to an untracked file (`docs/` is excluded at
`.git/info/exclude:20`, and it was not `git add`ed).

### The task changed shape mid-build, and the census is why

This started as "retire the two named orphans". A sandbox generation census at
21:32Z on 2026-09-06, after 20 redeploys in a day, found **six BM25 generations
totalling 1,104 MiB with one live at ~257 MiB**. Index persistence mints a
generation per boot and the manifest-driven GC does not reclaim the prior one,
so the leak is a per-boot growth term rather than a fixed pair of orphans. A
list of ids written before a boot cannot keep up with that.

So the selector is the manifest: retire every BM25 and vector generation whose
id neither manifest names as live. The two orphans this document opened with are
now two of five.

### The flag

`INDEX_GENERATIONS_RETIRE_AT_BOOT=true`

The literal `true`, matching `GRAPH_SCOPES_RETIRE_AT_BOOT` next to it, so a
stray value is not read as consent to move an index. The flag no longer carries
a list; that is the one place where the shape of the original packet could not
survive the respec, because the selector replaced the list.

Files move to `$DATA_DIR/retired/<stamp>/` through the entrypoint's existing
`retire_matching_file`: rename and never delete, silent when absent, idempotent,
one log line per file with its byte count. Putting a generation back is one `mv`.

### What it would move

**2026-09-05 07:05:57Z production store** (`2026-09-05-phaseA-close-store-diagnostics.json`):

| Action | Family | Generation | Files | Bytes | MiB |
|---|---|---|---|---|---|
| keep | bm25 | `idx_mtnp1c9s_3698dd9cd6e0` | 227 | 497,323,484 | 474.3 |
| **retire** | bm25 | `idx_mtj0pzb2_73ee689c0219` | 76 | 165,425,164 | 157.8 |
| **retire** | bm25 | `idx_mtlwdg4b_4d6f0fb52cfe` | 72 | 156,302,108 | 149.1 |
| keep | vectors | `idx_mtnp1k57_...` | 29 | 57,311,888 | 54.7 |

**148 files, 321,727,272 bytes, 306.8 MiB.** That is the same pair section 3 of
this document found, reached by a mechanism that does not need them named.

**2026-09-06 21:32Z sandbox census** (experiment log, lines 981 to 990):

| Action | Generation | MiB |
|---|---|---|
| keep | `mtow4iaa` | ~257 |
| **retire** | `mtorf55a` | ~258 |
| **retire** | `mtow62p9` | ~169 |
| **retire** | `mtj0pzb2` | ~158 |
| **retire** | `mtlwdg4b` | ~149 |
| **retire** | `mtohwasy` | ~113 |

**~847 MiB of 1,104 MiB.** At the census's own k of 2.4 to 2.9 that is ~2.0 to
2.4 GB resident, larger than any single lever in the composition table.

### The filename correction

The on-disk name of a shard is

```
mem%3Aindex%3Abm25%3A<family>%3Aidx_<id>_<hex>%3A<NNNNN>.bin
```

for example `mem%3Aindex%3Abm25%3Abm25%3Aidx_mtnp1c9s_3698dd9cd6e0%3A00222.bin`.
The task packet's example, `mem%3Aindex%3Abm25%3Abm25%3Aidx%3Amtj0pzb2*`, is the
diagnostics endpoint's `byScope` grouping key, which splits those names on
`[:_]`. It is not a filename and matches nothing on disk. `retire_scope` cannot
spell these either: it encodes a literal scope name, and neither the hex suffix
nor the shard number is known before the glob runs.

### Why the live id is read from the manifest keys by name

`src/state/index-persistence.ts` stores the gc ledger under
`` `${manifestKey}:gc` `` in `KV.bm25Index`, which is the manifest's own scope.
The engine writes one file per scope. So `mem%3Aindex%3Abm25.bin` (44,092 bytes
on the 09-05 store) holds the BM25 manifest, the vector manifest, and both
ledgers, and the ledgers name every orphan alongside the live one. **A grep of
that file for a generation id refuses exactly the generations this flag exists
to move.** The reader takes `data:manifest` and `vectors:manifest` by key name
and reads `generation` from each.

The file format was read off the scope files themselves: the engine writes a
scope as `rkyv::to_bytes(KeyStorage(serde_json::to_string(scope_map)))`, so the
JSON body runs from offset 0 to the last `}`. That shape was checked against both
graph scope files and matched to within one byte. Values are read as
either objects or JSON-encoded strings, because which the engine writes is not
pinned by a type in this repo and handling both costs one line.

### Fail closed

An absent or unparseable manifest moves nothing and logs once. Without a
manifest nothing on disk can be told live from dead, and retiring the live index
costs a full-corpus rebuild.

### Fail-first, pass, mutation

Nine tests added to `test/deploy-entrypoint-scope-retire.test.ts`, run against
the real Railway entrypoint. Against the parent (`229ee30`), six fail:

```
× moves the five dead generations and leaves the live one
× reads a manifest whose values are JSON-encoded strings
× logs each move with its size
× moves nothing and logs once when the manifest file is absent
× moves nothing when the manifest is present but unparseable
× retires the vector generation when only the BM25 manifest names one
      Tests  6 failed | 13 passed (19)
```

The count reads 19 because the file already held 10 tests and this adds 9. All
10 originals pass on the parent, and so do three of the nine new ones
(idempotent, flag unset, live vector kept): they are guard tests, and on the
parent nothing moves at all. The six above are the discriminating ones. With the
commit applied, all pass alongside the drift guard:

```
 Test Files  2 passed (2)
      Tests  24 passed (24)
```

Two mutations, both fatal:

| Mutation | Result |
|---|---|
| live filter never matches (`*"\|__mutation__\|"*`) | `expected [ …(8) ] to deeply equal [ …(5) ]`, the three live files moved |
| fail-closed guard dropped (`if false`) | both manifest-absent tests die; it retired shards with no manifest at all |

### Gates

| Gate | Parent `229ee30` | Branch `1d6891d` |
|---|---|---|
| `npm test` | 5 failed, 2007 passed, 1 skipped (2013) | 7 failed, 2014 passed, 1 skipped (2022) |
| `npx tsc --noEmit` | 29 errors | 29 errors, list diff empty |
| `npm run build` | | exit 0 |

The +9 total is the nine new tests. `npm test`, not bare `vitest run`, so
`test/integration.test.ts` stays excluded.

Every failure on both sides is a 5,000 ms timeout in a file unrelated to this
change, and neither entrypoint test file failed on either side. Pre-existing
status was proven, not assumed: the four files that failed on the branch but not
on the parent (`context-injection`, `observe-implicit-session`,
`remember-supersede-recall`, plus `copilot-plugin`) were run as one identical set
on each worktree back to back:

```
parent: Test Files  1 failed | 4 passed (5)   Tests  2 failed | 28 passed (30)
branch: Test Files  1 failed | 4 passed (5)   Tests  2 failed | 28 passed (30)
```

Same shape both sides, and in both the only failing file is
`test/copilot-plugin.test.ts` with the victim test rotating between runs.
`hook-project` is on the known-flaky list in `.claude/rules/pr-governance.md`.

### Sandbox environment change

One variable name, set on the service, no value beyond the literal:

- `INDEX_GENERATIONS_RETIRE_AT_BOOT`

Nothing was deployed and nothing was set. That is the operator's step.

### Limitations

_The bullets below are as of `1d6891d`, the commit this section records._ Four of
them read as durable claims about the code and are not. The reader has since been
run against a real engine-written scope file, by the 02:58:06Z sandbox deployment
the PR body records, which retired five dead BM25 generations and kept the live
one. `270a42f` made the skip log distinguish its two cases. `f527c4d` deleted `_gbase`, so the retire loop's variables
at head are `_live`, `_sep`, `_gf`, `_gname`, `_gshardless`, and `_gen`, still
disjoint from the helper's, and `git grep _gbase` at head returns only the bullet
below. `npm test` is green at head: 182 files and 1996 tests pass, with one file and
one test skipped.

- **This does not fix the leak.** `index-persistence.ts` still strands a
  generation per boot. This moves them off the eagerly-loaded store after the
  fact, once per boot, so the store sawtooths instead of growing. The per-boot
  reclaim belongs in the gc ledger and is a separate change against
  `origin/production`.
- **The reader was never run against a real engine-written scope file.** No
  state store exists on this host, and nothing was deployed. It is built to the
  format the graph redesign plan's Appendix documents and verified against a
  fixture shaped that way, including a trailer after the JSON body. If the real
  file parses differently the flag fails closed and moves nothing, which is the
  safe direction, but it would then be a no-op until the reader is corrected.
- **Whether a scope value is an object or a JSON-encoded string is not pinned.**
  Both are handled and both are tested; neither has been observed on a real file.
- **The 21:32Z figures are the census's own rounded MiB**, not a byte-exact read.
  The 09-05 figures are byte-exact from the diagnostics JSON.
- **The entrypoint now calls `node`** to parse the manifest, which it did not
  need before. Every deploy target is a node image and the app itself is node,
  so the binary is present before the engine starts. If it ever is not, the call
  exits non-zero, `_live` is empty, and the run takes the same fail-closed path
  as an unparseable manifest: it moves nothing and logs the skip. A missing
  binary is therefore safe and visible in the boot log, not a silent retire.
- **The skip log does not say which failure it hit.** Absent file and failed
  read produce the same line, because `stderr` from the reader is dropped to
  keep an absent manifest quiet. Distinguishing them is free (the `[ -f ]` test
  is right there) and would tell an operator whether the format assumption above
  is the problem. Left out to keep this to the one commit the task asked for; it
  is a one-line follow-up.
- **No variable collision with the shared helper**, checked rather than assumed:
  `retire_matching_file` assigns `_dir`, `_name`, `_f`, `_dest`, and `_size`,
  and the retire loop uses `_live`, `_sep`, `_gf`, `_gname`, `_gbase`,
  `_gshardless`, and `_gen`. Disjoint. An edit that adds `_live` or `_sep` to
  the helper would turn the filter into "retire everything".
- **`npm test` is not green on either side.** 5 to 7 timeout failures in
  unrelated files. Proven equivalent, not proven absent.

## Why the manifest, not a list

The four deploy entrypoints and the test file each carried the census numbers and
the on-disk format derivation verbatim, so one paragraph existed in five copies.
`deploy-entrypoint-drift.test.ts` normalises through `code()`, which drops every
line starting with `#`, so those copies were unpinned and could drift silently.
The prose lives here now and the entrypoints carry a pointer.

### The backlog the census measured

Index persistence mints a generation per boot and the manifest-driven GC does not
reclaim the prior one, so a store grows by roughly one whole index per redeploy.
The 2026-09-06 21:32Z sandbox census, on a service with 20 redeploys in a day:
six BM25 generations totalling 1,104 MiB, one of them live at ~257 MiB. That is
~847 MiB of dead index, larger than any single lever in the composition table.

Those are the census's own rounded MiB figures. The byte-exact production figures
come from `docs/investigations/2026-09-05-phaseA-close-store-diagnostics.json`.

### Why a list of ids cannot be the selector

A list written ahead of a boot cannot keep up with a per-boot growth term. It is
also wrong in practice, which was measured rather than argued.

The 21:32Z census named `mtow4iaa` as the live generation. When the change ran on
that same store at 02:59Z the next morning, the manifest named `mtorf55a`, and
the code kept `mtorf55a`. A hardcoded list built from that census would have
retired the live index and forced a full-corpus rebuild: `src/index.ts:488` sets
`needsRebuild = bm25Index.size === 0`, and `rebuildIndex` awaits an
embedding-provider call per record across every observation in the corpus.

### Why the manifest is read by key name and not grepped

`src/state/index-persistence.ts` stores the gc ledger under `` `${manifestKey}:gc` ``
in `KV.bm25Index`, which is the manifest's own scope, and the engine writes one
file per scope. So `mem%3Aindex%3Abm25.bin` (44,092 bytes on the 09-05 store)
holds the BM25 manifest, the vector manifest, and both ledgers, and the ledgers
name every orphan alongside the live one. A grep of that file for a generation id
refuses exactly the generations this flag exists to move.

The reader takes `data:manifest` and `vectors:manifest` by key name and reads
`generation` from each.

### The on-disk scope format the reader assumes

The engine writes a scope as
`rkyv::to_bytes(KeyStorage(serde_json::to_string(scope_map)))`: the scope's JSON
object as raw bytes from offset 0, then a short rkyv trailer. So the JSON body is
`data[0 .. rfind("}") + 1]`, which is what `raw.lastIndexOf(0x7d) + 1` takes.

The derivation was first written up in the graph memory redesign plan's Appendix,
verified there against both graph scope files to within one byte. It is restated
here because that plan document is committed on no branch, and a citation to an
uncommitted file is not a citation.

A value under a manifest key is read as an object or as a JSON-encoded string,
because which one the engine writes is not pinned by a type in this repo. Both
are handled and both are tested.

**Ceiling.** `raw.lastIndexOf(0x7d)` is the only place in this repo coupled to
the engine's on-disk scope format. Grepping `src/`, `test/`, and `scripts/` for a
raw scope-file read returns this change and nothing else. An engine upgrade that
changes the trailer breaks the reader in the fail-closed direction, so the cost
is a skipped retire and not a lost index. The entrypoint carries a `ponytail:`
marker naming that ceiling.

---

## review round 2 fixes

Two round-2 reviews ran against `cf1c7ff`: a code review (lens A) and a ponytail
review (lens B). Neither found a P0 or a P1. Lens A raised one P2 (a PR-body
defect) and three P3. Lens B named three cuts. Both keep lists were settled and
are not re-opened. This section records what landed.

### The commits

| commit | what |
|---|---|
| `7f2c10a` | `refactor(retire)` collapse the destination branch to a default expansion (lens B cut 1) |
| `2e0335f` | `test(retire)` drop the `containing` fixture; pin the helper's own behaviour (lens B cut 2 + lens A P3-1) |
| `6b710cd` | `docs(retire)` trim the two-message comment; correct the process count (lens B cut 3 + lens A P3-3) |
| `cdf6b46` | `docs(retire)` repair the three cross-references (lens A P3-2) |
| `e85f68c` | `docs(retire)` PR body: disclose the shared-helper change, name the deployed commit (lens A P2-1) |
| `bcdb75b` | `docs(retire)` say what the doc-pointer assertion needs from a new pointer (comment only) |

`bcdb75b` is the last commit that touches a file under `deploy/` or `test/`, and
it changes a comment. Everything after it is documentation.

### The destination collapse does not spawn a date in batch mode

Lens B's cut 1 replaces a five-line `if` with
`_dest="${_retire_dest:-$DATA_DIR/retired/$(date -u +%Y%m%dT%H%M%SZ)}"`. The
doubt worth measuring is whether `$(date)` still stays unspawned when the caller
sets a destination. A counting stub on `PATH` appended a line per spawn. Both
forms, three states, three shells, 18 rows, all agreeing:

```
form=old mode=batch dest=/preset                        date_spawns=0
form=new mode=batch dest=/preset                        date_spawns=0
form=old mode=empty dest=/data/retired/20260906T000000Z date_spawns=1
form=new mode=empty dest=/data/retired/20260906T000000Z date_spawns=1
form=old mode=solo  dest=/data/retired/20260906T000000Z date_spawns=1
form=new mode=solo  dest=/data/retired/20260906T000000Z date_spawns=1
```

Identical under `/bin/sh`, `/bin/dash`, and `/bin/bash`. The `empty` row is the
one that could have differed: `:-` treats null and unset alike, and so did the
`[ -n "${_retire_dest:-}" ]` test it replaces. The solo rows are the positive
control; without them a broken counter reads the same as a proven claim, which
is what the first run of this stub did.

### Fail-first for the new helper test

Lens A's P3-1 is that nothing on this branch tested what `1bd6aee` did to
`retire_matching_file`. The two new tests run against `a12dbdc` (`cf1c7ff~6`),
where the helper has no batch branch. The batch-mode test dies there:

```
 FAIL  test/deploy-entrypoint-index-retire.test.ts > the shared retire helper
       keeps both of its modes > sets _retire_dest: one directory for the run,
       counted not echoed
AssertionError: expected 'agentmemory: retired mem%3Aindex%3Abm…' not to match
                /retired mem%3Aindex/

+ Received:
"agentmemory: retired mem%3Aindex%3Abm25%3Abm25%3Aidx_mtj0pzb2_73ee689c0219%3A00000.bin,      300 bytes, to …/retired/20260906T071726Z
agentmemory: retired mem%3Aindex%3Abm25%3Abm25%3Aidx_mtlwdg4b_4d6f0fb52cfe%3A00000.bin,      301 bytes, to …/retired/20260906T071726Z
agentmemory: retired mem%3Aindex%3Abm25%3Abm25%3Aidx_mtnp1c9s_3698dd9cd6e0%3A00000.bin,      304 bytes, to …/retired/20260906T071726Z
agentmemory: retired mem%3Aindex%3Abm25%3Abm25%3Aidx_mtohwasy_5555cccc6666%3A00000.bin,      302 bytes, to …/retired/20260906T071726Z
agentmemory: retired mem%3Aindex%3Abm25%3Abm25%3Aidx_mtorf55a_7777dddd8888%3A00000.bin,      303 bytes, to …/retired/20260906T071726Z
"
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 9 skipped (11)
```

Read the destination on those five lines. They share one stamp, so the
`toHaveLength(1)` assertion passes at `a12dbdc` too: that loop did not cross a
second, and a single destination was incidental there rather than guaranteed.
The echo assertion is the discriminating one. The pair is what pins the if/else.

The unset-mode test passes at `a12dbdc`, and at `878174f`, on purpose. It pins
the shipped path the two audit callers take, which this branch must not change,
so its evidence is a mutation and not a fail-first.

Whole file against unmodified `878174f`: **7 of 11 fail**. The four that pass are
the positive control, the two guard tests (vacuously, nothing moves), and the
unset-mode helper test.

### Mutations

Baseline is 17 tests across `deploy-entrypoint-index-retire` and
`deploy-entrypoint-drift`, all green. Every mutation was applied to all four
entrypoint copies unless noted.

| mutation | round 1 | round 2 review | after these fixes |
|---|---|---|---|
| live filter never matches | 3 fail | 3 fail | **4 fail** |
| both fail-closed guards removed | 2 fail | 2 fail | 2 fail |
| shared helper clobbers `_sep` | 3 fail | 3 fail | **4 fail** |
| `\|` delimiters removed | 0, survived | 1 fail | 1 fail |
| per-file log `echo` replaced with `:` | not run | **0 fail, full suite green** | **1 fail** |
| batch destination scattered one file per directory | not run | **0 fail** | **1 fail** |
| doc pointer rewritten to a path that does not exist | not run | **0 fail, 5 drift green** | **1 fail of 6 drift** |

The delimiter row is the one that could have regressed. Dropping the `containing`
fixture did not weaken it: `contained` carried that mutation on its own, which is
why `containing` was cut.

The echo row is the strongest number here, because it is a before and after on
one measurement. Lens A ran that mutation against the **entire suite** and got
182 files and 1993 tests green. Re-run against the entire suite now:

```
FAIL  test/deploy-entrypoint-index-retire.test.ts > the shared retire helper
      keeps both of its modes > leaves _retire_dest unset: own stamp directory,
      one line per file
 Test Files  1 failed | 181 passed | 1 skipped (183)
      Tests  1 failed | 1995 passed | 1 skipped (1997)
```

### Gates, measured at `bcdb75b` in the branch worktree

| gate | result |
|---|---|
| `npm test` | Test Files **182 passed, 1 skipped (183)**. Tests **1996 passed, 1 skipped (1997)**. Duration 12.12 s. Exit 0. |
| `npx tsc --noEmit` | 29 errors on both sides. `diff` of the two sorted error lists against a detached `878174f` worktree is **empty**. Exit 2 on both, which is the pre-existing baseline. |
| `npm run build` | Exit 0. 20 files, 3.17 MB, 4108 ms. |

`npm test` and not bare `vitest run`, so `test/integration.test.ts` stays
excluded. No flake appeared on this host. All three were run again at `bcdb75b`
after the earlier run at `cdf6b46`, and agreed. The documentation commits after
`bcdb75b` cannot move them, because the only test that reads anything under
`docs/` reads a path and not a file's contents.

The four entrypoints are byte-identical over the whole retire region, lines 93 to
225, `shasum` `9e1e9bd1bb4d` on each.

### The three cross-references, and what each became

- **Rewritten.** `test/deploy-entrypoint-index-retire.test.ts` named
  `retire_scope`, which is the experiment branches' helper and does not exist
  here. It now names `retire_matching_file`, matching the entrypoint paragraph
  that was already corrected in round 1.
- **Removed.** The citation of
  `docs/plans/2026-09-06-001-graph-memory-redesign-plan.md` at the on-disk format
  derivation. That file is committed on no branch. The byte check it carried is
  now stated in place as the measurement it is. This makes the section consistent
  with what "The on-disk scope format the reader assumes" already says further
  down: a citation to an uncommitted file is not a citation.
- **Kept and guarded.** The entrypoints' pointer to this document resolves, and
  nothing kept it resolving, because `deploy-entrypoint-drift` normalises through
  `code()` and drops every `#` line. One assertion there now sweeps every
  `docs/**.md` path in all four copies and fails on any that does not resolve. It
  reports the path it lost rather than a bare `false`.

### Left alone, so a round 3 does not re-raise them

- **The `ponytail:` marker at `deploy/*/entrypoint.sh` ships.** Round 1's PR gate
  asked for confirmation that none did. One does, added on the round-1 ponytail
  review's own recommendation, and it names a real ceiling. `src/functions/session-sweep.ts`
  carries one and is already on `origin/production`, so it matches the target
  branch's convention. This holds because the PR targets `origin/production`. For
  an upstream maintainer the persona label would mean nothing and the same
  content should be plain prose.
- **The recursive ownership call is still one per moved file** inside the loop,
  where `retire_stream_files` makes the same call once after its loop. Lens B
  measured the cost: about 148 forks and roughly 11,000 inode touches, once, on
  the boot that drains the backlog. It is not a regression, because the per-call
  date stamp already shared a directory in the common case. It is a separate
  logical change and is not in this branch.
- **`GRAPH_SCOPES_RETIRE_AT_BOOT` in the gate comment** names a flag this branch
  does not have. Kept deliberately so the block stays byte-identical with the
  branch it was measured on, and disclosed in the PR body's limitations. After
  the `retire_scope` fix above, the body's count of "one comment" is exact.
- **Three `src/` paths at "What the rebase had to change"** sit inside a
  `git ls-tree` transcript whose output is `(empty)`. Their absence is the point.
- **`test/deploy-entrypoint-scope-retire.test.ts` in the fail-first record** is
  the name the test file had when that run was made.
- **The `containing` fixture is gone, and one delimiter spelling stays
  unpinned.** `contained` kills the both-delimiters-dropped and
  leading-delimiter-dropped mutations. Dropping only the *trailing* delimiter
  (`*"$_gen|"*`) is killed by neither fixture, before this change or after it, as
  lens B's own table shows. Lens B offered a swap that would close it, the live
  id minus its *first* character, explicitly as optional. It is a swap rather
  than a cut, so it was not taken.
- **The two diagnostics JSON files this document cites** are under
  `docs/investigations/`, which is excluded from git here, so they resolve
  locally and not for a reader of the branch. That is pre-existing, it applies to
  the PR body as well, and neither round-2 lens raised it.

## review round 3 fixes

Round 3 ran two lenses over `66e5996`. Lens B (ponytail, ULTRA) returned SHIP
AFTER 3 CUTS, worth -13 lines. Lens A (code review) returned 0 P0, 0 P1, 0 P2,
and 3 P3, all of them numbers in the two committed docs. Both reports are
untracked, as the round-1 and round-2 reports are:
`docs/investigations/2026-09-06-retire-idx-ponytail-review-r3.md` and
`-code-review-r3.md`.

### Commits

| commit | lens | what |
|---|---|---|
| `403d13a` | B cut 1 | helper contract comment, six lines to four, all four entrypoints |
| `37cfbaf` | B cuts 2 and 3 | duplicated summary-line assertion, and a comment the check cannot honour |
| `f67bec4` | A P3-1, P3-2, P3-3 | three counts corrected across the two docs and one test comment |
| `a6fe99c` | consequence of `37cfbaf` | two PR-body mutation counts re-trued, and the follow-up count replaced by its boundary |

Follow-ups after `a12dbdc` at this head: **19**, by
`git rev-list --count a12dbdc..HEAD`.

### The three cuts

**Cut 1, `403d13a`.** The comment above `retire_matching_file()` still ended by
restating what the call site says with its reasons attached, because `7f2c10a`
removed the `if` those two-and-a-half lines described and left them standing. The
sentence now ends one clause early. This is comment, which `code()` normalises
away, so `deploy-entrypoint-drift` cannot see it applied to three copies out of
four. It was applied by hand to all four and re-checked by hash.

**Cut 2, in `37cfbaf`.** The batch-mode helper test asserted the summary-line
template character for character identically to "moves the five dead generations
and leaves the live one", under the same setup. The two assertions above it, the
one-stamp-directory count and the no-per-file-echo regex, are what make the batch
test discriminating and they stay.

**Cut 3, in `37cfbaf`.** The doc-pointer guard's comment claimed the target has to
be committed rather than merely present. The check below it is `existsSync`,
which reads the working tree, so nothing enforces that. The three lines above it
stay.

Lens A read the same two lines and called them accurate, as a requirement on the
author rather than a claim about `existsSync`. The two readings do not conflict on
the fact, only on whether a test comment should carry a requirement its test
cannot check. Lens B's reading was taken. The requirement itself is not lost: it
is stated here, and `docs/` being in `.git/info/exclude` means a new pointer's
target is untracked and does not appear in `git status`, so an author adding one
has to `git add -f` it.

### The three counts

**P3-1, "six copies of the prose" is five.** Measured at `a12dbdc` with
`git grep -l` on three different phrases from the duplicated paragraph:

```
git grep -l '1,104 MiB'      a12dbdc  -> 4 entrypoints + index test = 5
git grep -l '847 MiB'        a12dbdc  -> 4 entrypoints + index test = 5
git grep -l 'rkyv::to_bytes' a12dbdc  -> 4 entrypoints + index test = 5
```

Four sites carried the claim and one of them is shipped test code. Where the
claim is about carriers it now says five and names the index test as the fifth.
Where it is about the entrypoints alone, which is the PR body's drift paragraph
and the drift test's own comment, it says four. `git grep 'six copies'` over the
tracked files returns nothing.

**P3-2, the evidence window.** The paragraph said "six follow-up commits" when ten
existed at the moment it was authored, and it anchored every sandbox number to
`1d6891d`, which is not reachable from this branch. It now names `a12dbdc` as
`1d6891d`'s rebased equivalent and the first commit of this PR, gives the
02:58:06Z boot the numbers were read at, and points at `git diff a12dbdc..HEAD`
so the byte-identity claim can be checked rather than trusted.

`f67bec4` first replaced the count with "eighteen", predicting the head after one
more commit. That prediction was never true at any head, which is the fourth time
this integer has been wrong, so `a6fe99c` removed it and gave the boundary and the
listing command instead. The measured count lives here, above, where a
point-in-time number belongs.

**P3-3, the rebase doc's own two errors.** The `### Limitations` block still
listed `_gbase`, which `f527c4d` deleted. `git grep _gbase` at head returns
exactly that one line. The block is a point-in-time record of `1d6891d`, so it
keeps its bullets and gains an as-of marker naming those that read as durable
claims about the code and are not. `f67bec4` named three, and round 4 found a
fourth.

The byte-identity sentence paired `shasum` `9e1e9bd1bb4d` with lines 95 to 228.
That hash is lines 95 to 227 at `66e5996`, and 228 was `cat > "$III_CONFIG"`,
outside the retire region. Cut 1 moved the region up two lines, so the sentence
now reads lines 93 to 225 at `9e1e9bd1bb4d`. `f67bec4` moved only the end line,
and round 4 moved the start.

### What the cuts moved, and was re-trued

Cut 2 removed the batch test's only reader of the two mutations that break
selection, so both fall from 4 dying tests to 3. Every mutation still dies, and
nothing was killed only by the deleted line, which is why the cut was sound. The
two PR-body rows were corrected in `a6fe99c`. The round-2 mutation table above is
a point-in-time record of that round and keeps its numbers.

Cut 2 does not touch the fail-first record. Re-run at `878174f` with the branch's
test file copied into an otherwise pristine worktree: **7 of 11 fail**, and the
four that pass are the same four the PR body names, read from `--reporter=verbose`
output rather than inferred.

### The item priced and not taken

Lens B priced folding the batch-mode test into the `L185` test at about -13 more
lines and excluded it from its own count, calling it a consolidation of code that
should exist rather than dead weight. It was not taken. It would drop the index
test file from 11 tests to 10, which stales the fail-first record above, the named
test in the transcript, and the mutation table's attribution for the batch row.

### Mutations, re-run at `f67bec4`

Baseline 17 tests across `deploy-entrypoint-index-retire` and
`deploy-entrypoint-drift`, all green. Every mutation applied to all four
entrypoint copies. Harness and per-run output in the round-3 scratchpad.

| mutation | after round-2 fixes | after round-3 fixes | test that dies |
|---|---|---|---|
| live filter never matches | 4 fail | **3 fail** | moves-five, JSON-encoded values, substring neighbour |
| both fail-closed guards removed | 2 fail | 2 fail | absent manifest, unparseable manifest |
| shared helper clobbers `_sep` | 4 fail | **3 fail** | the same three |
| `\|` delimiters removed | 1 fail | 1 fail | substring neighbour |
| per-file log `echo` replaced with `:` | 1 fail | 1 fail | helper unset mode |
| batch destination scattered one file per directory | 1 fail | 1 fail | helper batch mode |
| doc pointer rewritten to a path that does not exist | 1 fail of 6 drift | 1 fail of 6 drift | drift path-exists |

No mutation survives.

### Gates, measured at `f67bec4` in a detached worktree

| gate | result |
|---|---|
| `npm test` | Test Files **182 passed, 1 skipped (183)**. Tests **1996 passed, 1 skipped (1997)**. **Exit 0.** No failure to trace, and none of the known flakes appeared. |
| `npx tsc --noEmit` | **29 errors** at head, **29** on a pristine `878174f` worktree, `diff` of the two sorted error lists **empty**. Exit 2 on both, which is the pre-existing baseline. |
| `npm run build` | **Exit 0.** 20 files, 3.17 MB, 3706 ms. |

`npm test` and not bare `vitest run`, so `test/integration.test.ts` stays
excluded. The gates were run at `f67bec4`. `a6fe99c` and this section are
documentation, and the only test that reads anything under `docs/` reads a path
and not a file's contents.

The four entrypoints are byte-identical over the whole retire region after cut 1,
measured on each of the four rather than on one and inferred: lines 93 to 225,
`shasum` `9e1e9bd1bb4d` on railway, fly, render, and coolify. The helper's
comment block plus the retire region, lines 89 to 225, agrees the same way at
`5d9bb326252f`.

## review round 4 fixes

Round 4 ran two lenses over `06e0f98`. Lens A (code review) returned 0 P0, 0 P1,
0 P2, and 2 P3, both of them numbers in this doc and both regressions from
`f67bec4`. Lens B (ponytail) returned SHIP AFTER 1 CUT, worth -12 lines, and the
cut was declined. Both reports are untracked, as the round-1, round-2, and
round-3 reports are:
`docs/investigations/2026-09-06-retire-idx-code-review-r4.md` and
`-ponytail-review-r4.md`.

### Commits

| commit | lens | what |
|---|---|---|
| `ea76542` | A P3-1, P3-2 | the retire-region range at three sites, and the as-of marker's stale-bullet count |

### The two findings

**P3-1, the retire-region range.** `f67bec4` re-trued the byte-identity sentence
after cut 1 by moving the end line from 227 to 225 and leaving the start at 95.
Cut 1 moved both ends. Measured at `06e0f98` on all four entrypoint copies rather
than on one and inferred: `retire_matching_file() {` opens at line 93, the blank
line that closes the region is 225, and `cat > "$III_CONFIG" <<'EOF'` is 226.

| span | `shasum` | what it is |
|---|---|---|
| 93 to 225 | `9e1e9bd1bb4d` | the retire region, identical on all four copies |
| 95 to 225 | `13cb38b03420` | the span this doc documented, real but starting two statements into the helper body |
| 89 to 225 | `5d9bb326252f` | the helper's comment block plus the region, identical on all four copies |
| 89 to 224 | `e6957b99a290` | the superset this doc documented, ending one line before its own subset ended |

Every error across the four rounds was in the span label and none was in the
measurement. `9e1e9bd1bb4d` is and always was the region's hash, which is why the
round-3 record above carries it against "lines 95 to 228" and the corrected sites
now carry it against 93 to 225.

**P3-2, the as-of marker's count.** Round 3's P3-3 named three bullets that read
as durable claims about the code and are not: the reader, the skip log, and
`npm test`. The marker `f67bec4` wrote enumerates the skip log, `_gbase`, and
`npm test`, substituting `_gbase` for the reader while holding the total at
three. The union of the two lists is four. The reader bullet is the fourth, and
the 02:58:06Z sandbox deployment answers it. Retiring five dead BM25 generations
while keeping the live one is only possible if the reader parsed a real
engine-written manifest and resolved live from dead correctly.

### The cut priced and declined

Lens B priced `test/deploy-entrypoint-index-retire.test.ts:103-114` at -12 lines,
the third carrier of the on-disk filename paragraph. Round 1's cut 4 (`cf1c7ff`)
kept that paragraph in all five carriers "because the glob is unreadable without
it". The test file has no glob, so the stated reason does not reach it, and the
lens called this a judgment call overriding a reasoned keep rather than a defect.
It was declined. `cf1c7ff`'s ruling stands, and the file builds the same names
through `shardName` at `:127-128` whether or not the prose sits above it.

### Gates

Both findings are documentation-only and no code changed, so round 4's own
measurements at `06e0f98` stand: `npm test` at 182 files and 1996 tests passing
with one of each skipped, exit 0. `npx tsc --noEmit` at 29 errors on head and 29
on a pristine `878174f`, the two sorted lists identical, exit 2 on both as the
pre-existing baseline. `npm run build` exit 0. All seven mutations die, and
fail-first reproduces 7 of 11.

`ea76542` was re-checked against the two entrypoint test files,
`deploy-entrypoint-index-retire` and `deploy-entrypoint-drift`: **17 tests, 2
files, all green** in 4.37 s. The four copies still hash `9e1e9bd1bb4d` over
lines 93 to 225 after the commit, so the documentation change moved no code.
