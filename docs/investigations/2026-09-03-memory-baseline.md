# Memory baseline — U0 of the production memory-reduction ladder

**Status: procedure only. Every number below is an empty slot.** Nothing here has
been measured yet, because the two reads it needs are 6 hours apart on a
container running this endpoint, and this endpoint has not shipped. Do not fill a
slot from the 2026-08-28 breakdown or from an estimate — R7 exists specifically
to forbid that, and a fabricated k propagates into every gate in the ladder.

Plan: `docs/plans/2026-09-03-0317-perf-memory-reduction-ladder-plan.md` (U0).

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
curl -sS -H "Authorization: Bearer $AGENTMEMORY_SECRET" \
  https://<service>/agentmemory/diagnostics/store | tee read-1.json | jq '{
    at,
    dataDir, dataDirSource,
    state: .stores.state | {fileCount, totalBytes, byScope},
    stream: .stores.stream | {fileCount, totalBytes, byScope},
    node: .process.node,
    engine: .process.engine,
    cgroup: .process.cgroupCurrentBytes,
    index: .index
  }'
```

**Check the instrument before trusting any of it**
(`docs/solutions/measurement/prove-the-instrument-before-trusting-a-negative.md`):

- [ ] `dataDirSource` is `resolver` or `deploy-default`, **not** `unresolved`.
      `unresolved` means neither candidate held a `state_store.db` and every byte
      figure below is a false zero.
- [ ] `stores.state.fileCount` is in the thousands, not 0.
- [ ] `process.engine.processes` is non-empty. If `unavailable` is set, the
      `/proc` scan found no `iii` process and **k cannot be computed** — fall
      back to the plan's Appendix `railway ssh` one-liner and record that the
      endpoint's engine half did not work in this image.
- [ ] `process.node.rssBytes` is non-null.
- [ ] `process.cgroupCurrentBytes` is non-null.
- [ ] The whole call returned in under 5 seconds (U0's gate threshold).

Take the second read **6 hours later, on the same `deploymentId`**, under the
load and write floors. A deploy inside the window voids it (KTD2).

---

## Slot 1 — the two reads

| field | read 1 | read 2 |
|---|---|---|
| `at` (UTC) | | |
| `deploymentId` | | |
| node uptime (s) | | |
| state store bytes | | |
| stream store bytes | | |
| store total on disk | | |
| node RSS | | |
| engine RSS | | |
| cgroup current | | |
| BM25 entries | | |
| vector entries | | |

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
verbatim — U2 cannot be written until this is filled:

```
```

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
