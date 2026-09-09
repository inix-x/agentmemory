# Draft PR body

Branch: `perf/retire-orphaned-index-generations`, off `origin/production`
(`878174f`). Not pushed.

## Title

```
perf(retire): retire index generations the manifest does not name as live, at boot
```

## Body

```markdown
Index persistence mints a generation per boot and the manifest-driven GC does not
reclaim the prior one, so a store grows by roughly one whole index per redeploy.
`INDEX_GENERATIONS_RETIRE_AT_BOOT=true` moves every BM25 and vector generation
that neither manifest names as live into `$DATA_DIR/retired/<stamp>/` before the
engine starts.

Branched off `origin/production`. This carries the boot-time index retire and
nothing else from the sandbox experiment stack it was developed on: no
`GRAPH_PERSIST_ENABLED`, no `GRAPH_SCOPES_RETIRE_AT_BOOT`.

## What this does not fix, and what to weigh

- **It does not fix the leak.** `src/state/index-persistence.ts` still strands a
  generation per boot. This moves them off the eagerly-loaded store after the
  fact, once per boot, so the store sawtooths instead of growing without bound.
  The per-boot reclaim belongs in the gc ledger and is a separate change.
- **The reader is coupled to the engine's on-disk scope format, and no type in
  this repo pins that format.** The reader takes the JSON body as everything up
  to the last `}`, because the engine writes a scope as
  `rkyv::to_bytes(KeyStorage(serde_json::to_string(scope_map)))`: the JSON object
  from offset 0, then a short rkyv trailer. That trailer encodes the body length,
  so one of its bytes can itself be `0x7d`. The reader therefore retries from the
  previous `}` while the candidate stays within the last 12 bytes, which is what
  keeps a body length whose low byte is `0x7d` from reading as a broken file.
  Grepping `src/`, `test/`, and
  `scripts/` for a raw scope-file read returns this change and nothing else, so
  this is the only such coupling in the repo. An engine upgrade that changes the
  trailer breaks the reader in the fail-closed direction: the cost is a skipped
  retire, not a lost index. The entrypoint carries a `ponytail:` comment naming
  that ceiling and the upgrade path.
- **The fail-closed guard is on the whole read, not per family.** The reader
  skips the retire only when neither `data:manifest` nor `vectors:manifest`
  yields a generation, so when one key is usable and the other is absent or
  unreadable, that other family has no live id and every generation in it is
  retired.
- **On production the live/dead split has not been read from production's own
  manifest.** The 306.8 MiB figure below was computed from a store-diagnostics
  snapshot by grouping shard files under their generation, not by running the
  reader against production's `mem%3Aindex%3Abm25.bin`. On the sandbox the reader
  was run against the real engine-written file and was correct. If production's
  file parses differently the flag fails closed: it moves nothing and logs one
  skip line naming which failure it hit.
- **Whether a scope value is an object or a JSON-encoded string is not pinned by
  a type in this repo.** Both are handled and both are tested. Only the object
  form has been observed on a real file.
- **The entrypoint now calls `node`** to parse the manifest, which it did not
  need before. It runs as root before the `gosu` drop, and `node:22-slim` is the
  base image in all four Dockerfiles, so `node` is on `PATH` at that point. A
  future base-image change is the one thing that turns this into a no-op that
  logs the skip line but does not name the cause, and even then the call exits
  non-zero, the live list is empty, and the run takes the same fail-closed path.
- **The 21:32Z sandbox figures below are the census's own rounded MiB.** The
  production figures are byte-exact from the diagnostics JSON. The two are not
  the same kind of measurement.
- **One comment on this branch names a flag this branch does not have.** The gate
  comment reads "the same shape as `GRAPH_SCOPES_RETIRE_AT_BOOT`", and that flag
  lives only on the sandbox experiment branches. It is left as written so the
  index retire block stays byte-identical to the branch it was developed and
  measured on. Worth a follow-up word change, not worth diverging the two copies
  for.
- **`test/copilot-plugin.test.ts` is load-sensitive, and this branch adds
  load.** It fails intermittently under a full parallel run on this branch and
  on unmodified `878174f`, and passes 16 of 16 in isolation on both. The Tests
  section below traces the cause. The hook scripts behind it live under
  `plugin/`, which this PR does not touch, so fixing it is a separate change
  against `origin/production`.

## Why the live id is read from the manifest, not from a list

A list of ids written ahead of a boot cannot keep up with a per-boot growth term.
It is also wrong in practice, and that was measured, not argued.

The 2026-09-06 21:32Z sandbox census named `mtow4iaa` as the live generation.
When the change ran on that same store at 02:59Z the next morning, the manifest
named `mtorf55a`, and the code kept `mtorf55a`. A hardcoded list built from that
census would have retired the live index. That costs a full-corpus rebuild:
`src/index.ts:485` sets `needsRebuild = bm25Index.size === 0`, and `rebuildIndex`
awaits an embedding-provider call per record across every observation in the
corpus.

Grepping the manifest file for an id does not work either.
`src/state/index-persistence.ts` stores the gc ledger under `${manifestKey}:gc`
in the manifest's own scope, and the engine writes one file per scope, so
`mem%3Aindex%3Abm25.bin` holds both manifests and both ledgers, and the ledgers
name every orphan alongside the live one. A grep would refuse exactly the
generations this flag exists to move. The reader takes `data:manifest` and
`vectors:manifest` by key name and reads `generation` from each.

The full derivation, including the on-disk format and the census it replaces, is
in "Why the manifest, not a list" in
`docs/investigations/2026-09-06-reclaim-orphaned-generations-rebase.md`, which
this PR adds. The four entrypoints and the index test carry a pointer to it
rather than the five copies of the prose they used to carry.

## Real behaviour, and how each number was read

**The deployed commit was `1d6891d`**, on `feat/retire-orphaned-index-generations`.
Its rebased equivalent in this PR is `a12dbdc`, the first commit here. Every
sandbox number below was read off that deployment, which booted at 02:58:06Z.
Everything after `a12dbdc` is review follow-up, authored three to five hours later
and listed by `git log a12dbdc..HEAD`. The glob and the live filter are
byte-identical from `1d6891d` to the current head, and `git diff a12dbdc..HEAD` is
the in-PR way to check that. The manifest read gained a bounded retry past a `0x7d`
in the rkyv trailer, a strict superset of what it parsed before, so the numbers
still describe the code being merged. What else changed after the measurement is
the logging, the destination stamp, and the shared helper.

**Sandbox, deployed and measured (experiment log tick 35, 2026-09-06 02:59Z).**
The deployment of the change booted at 02:58:06Z and the worker registered 16 s
later. The store was read at 02:58:35Z, 0.5 min uptime, through the diagnostics
endpoint's `stores.state` split:

- **disk 1,757 MiB before, 911 MiB after: delta -846 MiB**, which matches the
  previous evening's census of ~847 MiB of dead index to the megabyte.
- Exactly one BM25 generation left on disk (`idx:mtorf55a`, 257.5 MiB) plus the
  vector generation (`idx:mtomzy01`, 54.7 MiB). Five dead BM25 generations moved
  to `/data/retired`. The live one was kept because the manifest named it.
- Engine RSS at that boot 2,601 MiB against 3,295 MiB on the previous boot, so
  846 MiB of index on disk cost roughly 700 MiB resident, k ~0.8, well under the
  whole-store 2.4 to 2.9.
- At 03:11Z, 13 min into settle, the process sat at 3,881 MiB, the first reading
  under the 4,096 idle target on any configuration. The prior graph-off
  configuration at the same age sat at 5,180 to 5,200.

The retire's log lines were not the proof. Railway's log tail already predated
them, so the evidence is the `byScope` diff. Fixing that is one of the changes in
this PR: the retire now emits one summary line instead of one per file.

**Loaded hour, 03:28Z to 04:29Z (tick 38).** 122 samples at a 30 s cgroup poll, 1
excluded. **Peak 4,760 MiB, minimum 3,893 MiB.** Replay sent 2,540+ posts with 0
errors across 31 session ends and one full pass. Against the prior graph-off
floor of 6,090 to 6,374 MiB that is **-1,614 MiB**, and against the 8,192 MiB
loaded target it leaves 3,432 MiB of margin.

**Sample verdict (tick 40, `.memory-loop/retire-idx-1.json`, exit 0, 120 samples,
0 excluded).**

| metric | prior floor (two samples) | this change | gate | verdict |
|---|---|---|---|---|
| cgroup peak MiB | 6,374 / 6,090 | **4,760** (03:59Z) | < 8,192 | PASS, margin 3,432 |
| cgroup idle MiB | 5,149 / 5,399 | **4,401** (04:57Z) | < 4,096 | FAIL by 305 |
| engine / node / disk MiB | 3,773 / 1,482 / 1,320 | 2,778 / 1,569 / 919 | | k 2.86 -> 3.02 |
| worker re-registrations | 0 | **0** | 0 | PASS |
| replay load | 2,700 | 2,570 posts in 60.12 min, **0 errors** | >= 2,565 | PASS |

Peak is down 25% and idle down 15% against that floor, both far past the 5%
discard rule the harness uses. The idle gate still fails by 305 MiB with the
graph off; closing that is other levers' work, not this one's.

**Production, computed and not measured.** From the diagnostics endpoint's
2026-09-05 07:05:57Z read of production, grouping `stores.state.byScope`
entries under `mem%3Aindex%3Abm25%3A*`:

| action | family | generation | files | bytes |
|---|---|---|---|---|
| keep | bm25 | `idx_mtnp1c9s_3698dd9cd6e0` | 227 | 497,323,484 |
| **retire** | bm25 | `idx_mtj0pzb2_73ee689c0219` | 76 | 165,425,164 |
| **retire** | bm25 | `idx_mtlwdg4b_4d6f0fb52cfe` | 72 | 156,302,108 |
| keep | vectors | `idx_mtnp1k57_…` | 29 | 57,311,888 |

**148 files, 321,727,272 bytes, 306.8 MiB.** Which two are dead is an inference
from that grouping, not a read of production's manifest. See the limitations
above.

## Safety

Retirement is a rename, never a delete. Files go to `$DATA_DIR/retired/<stamp>/`
on the same volume, so the move is `rename(2)`: no copy, no extra space needed,
and putting a generation back is one `mv`. A whole retire now uses one stamp, so
a generation's shards cannot be split across two directories by a loop that
crosses a second boundary. A test pins that: scattering the retire one file per
directory fails it.

The retire is silent and idempotent when there is nothing to move. An absent or
unparseable manifest moves nothing and logs once, and the two cases say which
one they are, because that line is the only production signal for the format
assumption in the limitations above.

The gate is the literal string `true`, matching the flag next to it, so a stray
value is not read as consent to move an index.

## Tests

Thirteen tests in `test/deploy-entrypoint-index-retire.test.ts`: ten index tests,
two that pin the shared helper's two modes, and a positive control. They run
against the real entrypoint rather than an extracted function, so the flag gate
and the ordering ahead of the engine config are the ones that ship. The positive
control asserts the already-shipped stream retire, so a "nothing was retired"
result cannot be a script that died on line one.

Run against unmodified `878174f` first: **10 of the 13 fail**, with the failure
text read rather than assumed. Three pass there: the positive control, the
flag-unset guard, and the helper's unset mode. That guard passes vacuously
because nothing moves at all. The helper's unset mode is the shipped path the audit
callers take, and it passes at `878174f` on purpose, because this branch must not
change it; its proof is the mutation below, not the fail-first. Every mutation
dies:

| mutation | result |
|---|---|
| live filter never matches | 5 tests fail |
| fail-closed guards removed | 3 tests fail |
| shared helper clobbers a loop variable | 5 tests fail |
| `\|` delimiters removed from the live test | 1 test fails |
| per-file log line replaced with `:` | 1 test fails |
| a batch retire scattered one file per directory | 2 tests fail |
| the entrypoints' doc pointer rewritten to a path that does not exist | 1 drift test fails |
| a batch retire stamped per call instead of once for the run | 2 tests fail |
| the reader's empty-list guard deleted | 1 test fails |
| a batch retire whose stamp directory is created eagerly | 1 test fails |
| the reader's retry past a `0x7d` in the trailer removed | 1 test fails |

The eager `mkdir` was measured surviving in review round 6. It left the
idempotent test green, because that test read only the files under `retired/`
and an empty stamp directory contributes none of them; two assertions now anchor
it. The retry row is not a survivor, because the retry is code this round added:
removing it restores the pre-fix reader and fails the one test that seeds a
colliding body length. The two before them were measured surviving in review
round 4. The per-call stamp
survived because the one-stamp assertion could only catch it when the loop
straddled a second boundary, so `date` is stubbed to a call counter and it now
fails on every run. The deleted guard made a manifest that parses but names no
generation read as "everything is dead", and nothing pinned it until one test
did. The three before them were measured surviving before that. Replacing the
per-file log line with `:` in all four entrypoints left the **entire suite
green**, 182 files and 1993 tests, so nothing anywhere pinned that line; the
same mutation now fails one test.

Four rows above moved without a new mutation being written for them. The trailer
test and the newly anchored idempotent test both die under the live filter and
under the shared helper, which takes those two rows from 3 to 5. The idempotent
test's directory-count assertion also catches the scattered destination and the
per-call stamp, which takes those two rows from 1 to 2.

The delimiter row is worth calling out. The live test is an exact-element test against
a pipe-delimited list, and until this branch nothing pinned the delimiters:
rewriting the pattern as a substring test left every index test green. It no
longer does. The failure is unreachable on today's ids, because `generateId`
mints a fixed-length id until roughly 2059, so this is a fixture and not a bug
report.

Gates: `npm test` was green at `53f3b8c` on 2026-09-06, one run, exit 0 (183
files: 182 passed, 1 skipped; 1999 tests: 1998 passed, 1 skipped). At `1324017`
two full runs returned exit 1, failing only `test/copilot-plugin.test.ts`. That
file passes 16 of 16 in isolation at `1324017` and at the unmodified base
`878174f`, and unmodified `878174f` fails it too once an equivalent parallel
load runs beside it. The cause is the 400 ms per-attempt fetch budget in
`postWithRetry` in `plugin/scripts/notification.mjs` and
`plugin/scripts/post-tool-failure.mjs`, which returns silently when the budget
expires. This branch changes no file under `plugin/` or `src/`, and the load it
adds is its own 13-test entrypoint test file.
`npx tsc --noEmit` at the pre-existing 29-error baseline,
verified by running tsc on a detached worktree at `878174f` and diffing the
sorted error lists rather than the counts: the diff is empty. `npm run build`
exit 0.

`deploy-entrypoint-drift.test.ts` holds the four deploy targets to one body and
passes here. It normalises through `code()`, which drops every `#` line, so it
cannot see comment drift; the four entrypoints were therefore also byte-compared
directly, and the index retire block is byte-identical across railway, fly,
render, and coolify. One comment is exempt from that blind spot: the entrypoints
point at one investigation doc rather than carrying four copies of its prose, and
a drift assertion now checks that every `docs/**.md` path in all four copies
resolves on disk.

## Composition with other work in flight

- **This stands alone off production.** It calls `retire_matching_file`, which
  production already has at `deploy/railway/entrypoint.sh:88`, and does not need
  the `retire_scope` helper the experiment branches add. **It also modifies that
  helper.** The destination is a caller-set `_retire_dest` when there is one, and
  a set destination makes the helper count rather than log per file. The two
  shipped audit callers are unchanged: with `_retire_dest` unset both branches
  take the production path, and a test now pins that mode. The
  `GRAPH_PERSIST_ENABLED` and `GRAPH_SCOPES_RETIRE_AT_BOOT` retires are
  sandbox-only and are deliberately not in this PR.
- It shares `deploy/*/entrypoint.sh` with those branches. Nothing here depends on
  them and they can land in either order.
- **A separate fix is still needed for the legacy audit file.** Production spells
  it `mem:audit.bin` and `mem_audit.bin`, neither of which the engine writes, so
  that file has never moved and was still in production's top-50 two days after
  the audit retire shipped. The correct spelling is `mem%3Aaudit.bin`. That is
  one logical change and belongs in its own PR, and it cannot be cherry-picked
  from the experiment branches because the commit that fixes it also introduces
  `retire_scope`.
```
