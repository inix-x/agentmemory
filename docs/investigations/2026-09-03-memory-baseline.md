# Memory baseline — U0 of the production memory-reduction ladder

**Status: procedure only. Every number below is an empty slot.** Nothing here has
been measured yet, because the two reads it needs are 6 hours apart on a
container running this endpoint, and this endpoint has not shipped. Do not fill a
slot from the 2026-08-28 breakdown or from an estimate — R7 exists specifically
to forbid that, and a fabricated k propagates into every gate in the ladder.

Plan: `docs/plans/2026-09-03-0317-perf-memory-reduction-ladder-plan.md` (U0).

**Both documents this file sends you to live outside the deployed branch.** The
plan above and
`docs/solutions/measurement/prove-the-instrument-before-trusting-a-negative.md`
are untracked working files, not on `production`. If a check below fails and you
are reading this from a fresh checkout, the fallback it names is not beside you —
get the plan from whoever is running the ladder rather than proceeding on the
number you already have, which is what a missing fallback quietly encourages.

---

## What this measures and why

The engine's two stores are one eagerly-loaded in-memory map with no eviction, so
resident bytes track what is on disk. KTD3 models that as **k**, resident engine
bytes per disk byte. Every later unit's gate is stated in terms of k, so k is the
first thing the ladder needs and the only thing U0 is really for.

Railway reports one combined container figure. `GET /agentmemory/diagnostics/store`
splits it: per-scope store bytes, node RSS versus engine RSS, and cgroup current.

---

## Read the endpoint

```bash
# Through the local auth proxy. AGENTMEMORY_SECRET is the value in /data/.hmac.
# Time it: the U0 gate is "answers in under 5 seconds".
curl -sS -w '\n== %{time_total}s\n' -H "Authorization: Bearer $AGENTMEMORY_SECRET" \
  https://<service>/agentmemory/diagnostics/store | tee read-1.json | jq '{
    at, success,
    dataDir, dataDirSource, candidates: .dataDirCandidates,
    state: .stores.state | {fileCount, totalBytes, byScope, unreadableFiles, unavailable},
    stream: .stores.stream | {fileCount, totalBytes, byScope, unreadableFiles, unavailable},
    largest: [.stores.state.largestFiles[0:6], .stores.stream.largestFiles[0:6]],
    node: .process.node,
    engine: .process.engine,
    cgroup: .process.cgroup,
    resolverUnavailable,
    bootUptimeSeconds: .process.bootUptimeSeconds,
    index: .index
  }'
```

**Check the instrument before trusting any of it**
(`docs/solutions/measurement/prove-the-instrument-before-trusting-a-negative.md`).
Every item here exists because a review lens showed the reading passing while
being wrong. Do not skip one because the number beside it looks plausible.

- [ ] `success` is `true`. It is computed, not hardcoded: both stores must be
      readable. An *absent* stream store still passes, which is why the next
      items check `unavailable` rather than `exists`.
- [ ] `dataDirSource` is `resolver` or `deploy-default`, **not** `unresolved`.
      `unresolved` means neither candidate held a `state_store.db` and every byte
      figure below is a false zero. On a miss, `dataDirCandidates` names what was
      tried.
- [ ] `stores.state.fileCount` is in the thousands, not 0. (1,903 files / 1,064 MB
      on 2026-08-28.)
- [ ] **`stores.state.unavailable` and `stores.stream.unavailable` are both
      absent.** An unreadable store reports `exists: true` with a reason; a
      genuinely missing one reports `exists: false` with none. A blind stream
      read would otherwise satisfy U1's gate by returning a frozen 0/0.
- [ ] **`stores.stream.fileCount` is recorded**, whatever it is. Nobody has ever
      counted this directory — the 2026-08-28 table covers `state_store.db`
      only. If it holds one file per stream *message* rather than per session
      group, the 5-second gate and the response size both change character.
- [ ] `unreadableFiles` is absent on both stores. Present means entries were
      dropped from `totalBytes`, so the denominator of k is short.
- [ ] `process.engine.processes` is non-empty **and `process.engine.unavailable`
      is absent**. It has three causes and the string says which:
      - *no iii engine process found* — the scan found nothing.
      - *VmRSS unreadable for N/M* — `engine.rssBytes` is null or a partial sum.
        Read the per-process `rssUnavailable`: "no VmRSS line" is a zombie, which
        means the engine died inside the window and the window is void too;
        anything else is an instrument problem and is retryable.
      - *sums N processes* — see the next item.

      For the first two, **k cannot be computed** — fall back to the plan's
      Appendix `railway ssh` one-liner.

      A pid that vanished mid-scan does **not** set this field. It is only noted
      inside the other messages, because on its own it does not make the reading
      incomplete.
- [ ] **If `process.engine.processes` has more than one entry, stop.** The
      endpoint now says so in `engine.unavailable`. VmRSS counts shared pages, so
      the sum overstates resident bytes, and `iii-*` is exactly the worker naming
      `deploy/railway/entrypoint.sh` uses. Steady state on 2026-08-28 was a
      single `iii` at 8,225 MB, so more than one entry is itself the finding.
      **Fallback:** the payload cannot separate shared from private pages — take
      the engine figure from the Appendix `railway ssh` one-liner instead, and
      record which process each reading came from.
- [ ] `process.cgroup.currentBytes` is non-null.
- [ ] `process.cgroup.currentBytes` is in the same order of magnitude as node RSS
      plus engine RSS. **Both directions mean something and neither is the one an
      earlier draft of this list claimed:**
      - Much **larger** is the non-namespaced-mount case. The host root cgroup
        accounts everything the container's does and more, so reading the host
        can only make this number bigger, never smaller.
      - **Smaller** than node + engine RSS does **not** indicate a mount problem.
        It is the expected shape when the engine RSS sum double-counts pages
        shared between processes — see the multi-process item above — because
        cgroup accounting charges a shared page once and RSS charges it per
        process.
- [ ] `resolverUnavailable` is absent. Present means `resolveDataDir()` threw and
      the candidate list is a candidate short, so `dataDirCandidates` is not the
      full set of paths that would have been tried.
- [ ] The call returned in under 5 seconds (U0's gate threshold).

Take the second read **6 hours later, on the same `deploymentId`**, under the
load and write floors. A deploy inside the window voids it (KTD2).

**An engine restart also voids it, and KTD2 does not cover that.** The worker
survives engine death and reconnects, so node uptime keeps climbing across one.
Compare `process.engine.processes[].startTicks` and `pid` between the two reads:
if either moved, the engine restarted, its RSS reset to the post-boot floor, and
the delta below is not a measurement. `startTicks` is raw clock ticks, so compare
it for equality rather than converting it.

**A null `startTicks` on either read voids the comparison, it does not pass it.**
`null === null`, so two failed reads look exactly like an engine that never
restarted. If `startTicks` is null on either side, fall back to comparing `pid`
alone and say in the closeout that restart detection was degraded.

**Record which instrument produced each read.** `stat().size` (this endpoint) is
apparent size; `du -sm` (the Appendix fallback) is allocated blocks. Under 1%
apart on ~1,900 files, but do not fold an instrument change into the delta.

---

## Slot 1 — the two reads

| field | read 1 | read 2 |
|---|---|---|
| `at` (UTC) | | |
| `deploymentId` | | |
| instrument (endpoint / `du -sm`) | | |
| node uptime (s) | | |
| **engine pid(s)** | | |
| **engine `startTicks`** | | |
| **`bootUptimeSeconds`** | | |
| state store bytes | | |
| state store file count | | |
| **stream store bytes** | | |
| **stream store file count** | | |
| store total on disk | | |
| node RSS | | |
| engine RSS | | |
| cgroup current | | |
| BM25 entries | | |
| vector entries | | |

Engine pid and `startTicks` must match across the two reads. If they differ the
window is void — see the engine-restart note above.

Request rate beside every count (R8): reads/min and `/observe` calls across the
span, from `railway metrics`.

| floor | required | achieved |
|---|---|---|
| load | 45 req/min for ≥1 h of the span | |
| write | ≥500 `/observe` calls in the span | |

---

## Slot 2 — k, and the data/churn split

```
k = engine RSS / (state store bytes + stream store bytes)
```

| quantity | read 1 | read 2 |
|---|---|---|
| k | | |

| split of the 6-hour engine RSS delta | bytes | share |
|---|---|---|
| RSS delta (read 2 − read 1) | | 100% |
| data (disk delta × k) | | |
| churn (remainder) | | |

**The split divides by the disk delta, and the disk delta is not clean.** The
engine re-serializes whole scopes every 5 seconds, and single scopes are large
relative to what is being measured: `mem:index:bm25:bm25` was 388.5 MB against a
measured 77-minute disk delta of only −62 MB. One save in flight during either
read can therefore perturb the split by more than the delta it divides. No
readdir-based reader can be atomic against a live writer, so **take three reads
at the second timepoint a minute apart and record the spread as the error bar**.
If the spread is comparable to the delta, the split is not a measurement and the
churn threshold below cannot be judged.

| repeat read at read-2 | disk total | engine RSS |
|---|---|---|
| a | | |
| b | | |
| c | | |
| spread | | |

**k is a function of engine uptime, not only of data.** The 2026-08-28
investigation measured engine RSS growing +1,071 MB in 77 minutes while the
store on disk *shrank* 62 MB, and attributed it to allocator fragmentation. So
k at 2 h of engine uptime and k at 20 h are different quantities. Record engine
uptime beside every k, and do not compare a k across a restart.

**Gate (U0).** k recorded; churn share under 30%; endpoint answers under 5 s.

**On fail.** Churn at or above 30% means resident data is not the whole story:
pause the ladder and open an allocator investigation **before U1**.

**Assumption check.** The plan assumes k is 4–7 (priors: 4.3 and 7.3). A measured
k **below 2** means the resident bulk is not data, and the ladder pauses for the
same allocator investigation.

---

## Slot 3 — per-scope bytes

From `stores.state.byScope`. The engine's on-disk naming is not pinned anywhere
in this repo, so **paste `largestFiles[0..5]` verbatim first** and confirm the
grouping split the names the way this table assumes.

| scope | files | bytes | share of store |
|---|---|---|---|
| `mem:obs` | | | |
| `mem:graph` | | | |
| `mem:index` | | | |
| `mem:audit` | | | |
| `mem:memories` | | | |
| `mem:semantic` | | | |
| `mem:emb` | | | |
| (other) | | | |

Verbatim largest files (naming evidence):

```
```

**Stream store file naming.** U2 retires every stream file except the viewer
group's, so it needs the naming from `stores.stream.largestFiles`. Paste it
verbatim — U2 cannot be written until this is filled. An **empty** list here
means "no stream files to name", which is a different answer from "the read
failed"; check `stores.stream.unavailable` before treating it as the former:

```
```

Also record `stores.stream.byScope`. `scopePrefix` collapses a filename only
when it splits into more than two `[:_]` segments. Every state-store name does.
A stream group file is named for the raw session id (`schema.ts:86` is
`group: (sessionId) => sessionId`, and `session-start.ts:73` generates
`ses_${Date.now().toString(36)}`), which splits to exactly three parts and does
**not** collapse — so `byScope` would carry one key per file. That is measured
here, not guessed at: at ~4,000 stream files it costs ~136 KB and is harmless;
if the count is far higher, the grouping needs a cap before any later unit reads
it.

| reading | value |
|---|---|
| `stores.stream.fileCount` | |
| `stores.stream.byScope` key count | |
| one key per file? | |

---

## Slot 4 — boot and log baselines

Not available from the endpoint. Pull these from Railway.

| reading | value | source |
|---|---|---|
| boot seconds (container start → first `livez` 200) | | `railway logs` |
| `Loaded persisted BM25 index (N docs)` | | boot log |
| snapshot file size | | `byScope` / largest files |
| `snapshot.topEdges` length | | `/agentmemory/graph/stats` |
| legacy `mem:audit` file size | | largest files |
| 24 h 5xx baseline, per 30-min bucket | | `railway logs --filter '@httpStatus:>=500'` |
| `Graph extraction failed: state::set` per 6 h | | `railway logs --filter` |

Run a known-positive control (`@httpStatus:413`) beside every filtered pull, or
the negative is not signal (R8).

---

## Slot 5 — the ranked lever table

Replaces the plan's estimate table. Re-rank U3 through U7 by measured bytes; the
plan's order is the estimate's order, not a finding.

| rank | unit | scope it removes | disk bytes | resident at measured k | risk |
|---|---|---|---|---|---|
| | | | | | |

**OQ3 decision.** U7 runs only if `mem:index` shard bytes on disk exceed 300 MB.

- Measured `mem:index` bytes: ______
- Verdict: U7 runs / U7 dropped

---

## Slot 6 — U0 gate verdict

| field | threshold | measured | pass |
|---|---|---|---|
| k | recorded | | |
| churn share of 6 h delta | under 30% | | |
| endpoint latency | under 5 s | | |
| load floor | 45 req/min ≥1 h | | |
| write floor | ≥500 `/observe` | | |
| tripwires (KTD14) | clean or explained | | |

Verdict: ______   Next: U1 / pause for allocator investigation
