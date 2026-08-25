---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
created: 2026-08-25
depth: deep
branch: fix/1223-heap-severity-denominator
---

# agentmemory hang resilience

## Goal Capsule

**Objective.** A wedged agentmemory backend recovers without a human, and a human
finds out that it happened.

**Means.** Two independent detection layers plus a notification layer, and the
deploy-path change that lets the in-process layer actually ship (KTD1, KTD6).

**Authority hierarchy.** Product Contract outranks Planning Contract. A user
instruction in session outranks both. Where this plan and
`~/.claude/rules/destructive-commands.md` disagree about running a deploy, the
rule wins: draft, show target, confirm.

**Stop conditions.** Stop and ask before any `railway up`, before any `railway
redeploy`, and before opening the upstream PR. Stop if U1's source build produces
a `dist/` that fails U1's parity check.

**Execution profile.** Verification-first. Every unit that changes runtime
behaviour carries a check that fails if the behaviour breaks.

**Tail ownership.** `ce-work` implements. Multi-lens subagent review follows, per
the user's instruction and `~/.claude/rules/code-review-methodology.md`.

---

## Product Contract

### Summary

On 2026-08-25 the agentmemory Railway service stopped serving while its process
stayed alive. Railway reported `Online` for about 8 hours. This was the second
occurrence. Nothing detected it and nothing recovered it. This plan makes the
failure self-healing and visible.

### Problem Frame

Two platform mechanisms should have caught it. Neither can, and the gap between
them is exactly where this failure lives.

- `healthcheckPath: /agentmemory/livez` gates a **new deploy** only. Railway's
  docs state: "Railway does not monitor the healthcheck endpoint after the
  deployment has gone live."
- `restartPolicyType: ON_FAILURE` fires when the process **exits**. This process
  hangs and never exits.

**CORRECTED 2026-08-26: the root cause below is wrong, and the correction is
load-bearing for every unit in this plan.** This is not an application hang. The
**iii engine process dies and the node process keeps running.** Verified by
`railway ssh` into a wedged container: `/proc` held only `tini` and
`node /usr/local/bin/agentmemory`, with **no `iii` process at all**;
`/proc/net/tcp` had one listener, `127.0.0.1:3113` (the viewer, owned by node),
while 3111, 3112 and 49134 were all unbound; `/data/state_store.db` mtime equalled
`last_ok` exactly.

The 3111 REST listener lives **inside the engine**, so it dies first, with the
engine, not last. That inverts F1 and F2 below. The `state::set` timeout in the
table is a **consequence** of the engine already being gone: an invocation with
no peer to answer it, timing out at the engine's own 180000 ms setting. The
engine died at 05:59:11Z, where the `ws` Sender errors are.

A dead engine is therefore invisible to the platform. Worse, the application
already collects the signal that would identify it and then discards it:
`src/health/monitor.ts` probes `kv.set`/`kv.get` every 30 seconds and measures
event-loop lag, writes the snapshot to KV, and returns. `src/health/thresholds.ts`
never reads `kvConnectivity`, and nothing acts on `status: "critical"`.

The observed failure sequence, from the Railway logs:

| Time (UTC) | Event |
|---|---|
| 08-24 20:45:00 | Deploy `a201e22d` succeeds |
| 08-24 20:45:46 | `[iii] Reconnecting` attempt 1 (starts at boot, unrelated to the fault) |
| 08-25 05:59:11 | `ws` Sender errors in `node_modules/ws/lib/sender.js` |
| 08-25 06:05:10 | `error Compression failed: "Invocation timeout after 180000ms: state::set"` |
| 08-25 06:08:19 | Last application log line, then silence |

Memory sat at 663.9 MB against an 8192 MB limit with CPU idle, so this was a hang
and not an out-of-memory event.

### Requirements

- **R1.** A process that stops serving on 3111 must be restarted without human
  action.
- **R2.** The restart mechanism must not exhaust `restartPolicyMaxRetries: 10`
  and leave the deployment permanently `CRASHED`. That outcome is strictly worse
  than the bug it replaces.
- **R3.** An outage, and a restart loop, must reach a human without a human
  polling for it.
- **R4.** Source-level fixes held in this fork must reach production. Today they
  cannot.
- **R5.** The health monitor must act on the failure signal it already collects,
  rather than recording it and returning.
- **R6.** No detection path may depend on `/agentmemory/health` while upstream
  issue #1223 is unfixed in production, because that route returns 503 on a
  healthy process.
- **R7.** The source-level fixes must be offered upstream to
  `rohitg00/agentmemory`, not held only in the fork.

### Actors

- **A1. The container process.** `agentmemory` under `tini`, PID equal to the
  entrypoint shell's PID after `exec`.
- **A2. The Railway platform.** Owns deploy-time healthchecks and the
  `ON_FAILURE` restart policy. Sees process exits, not hangs.
- **A3. The operator.** Currently the only detector. This plan removes that role
  from the recovery path and leaves it in the notification path.
- **A4. MCP clients.** Claude Code, Codex, and OpenCode. All read
  `AGENTMEMORY_URL=http://127.0.0.1:8899`, so they degrade and recover together.

### Key Flows

- **F1. Listener death.** The 3111 listener disappears while the process lives.
  The out-of-process watchdog detects it and forces an exit. Railway restarts.
- **F2. KV stall with a live loop.** `state::set` begins timing out while the
  event loop still runs. The in-process monitor detects it and exits before the
  listener dies. This is the path the real outage took at 06:05Z.
- **F3. Restart loop.** A deterministic wedge recurs on every boot. The
  once-per-boot cap bounds it, and the notification layer surfaces it.

### Acceptance Examples

- **AE1.** Given a live container, when the 3111 listener stops answering, then
  the container exits and restarts within roughly 4 minutes, and
  `/agentmemory/livez` returns 200 without operator action. Covers R1, F1.
- **AE2.** Given a live node process, when the KV probe fails on **10**
  consecutive 30-second collections, then the process exits. The threshold is 10,
  not 3: `src/index.ts` documents `state::set` exceeding the SDK's 30 s timeout
  under sustained hook load, and a 5 s probe cannot tell a slow store from a dead
  one. An earlier draft said "before the HTTP listener dies" -- **that is wrong**,
  the listener belongs to the engine and is already gone. Covers R5, F2.
- **AE3.** Given a wedge that recurs on every boot, when the watchdog acts, then
  it acts at most once per container lifetime, and watchdog action alone never
  drives the deployment to `CRASHED`. Covers R2, F3.
- **AE4.** Given a source-built image, when it is deployed, then
  `grep -rl heapSizeLimit <install-root>/dist/` returns at least one file.
  **`dist/` is bundled, not per-module** — `tsdown` emits hash-suffixed chunks
  (`src-CzgoepGU.mjs`, `index.mjs`) and there is no `dist/health/` directory, so
  the assertion must be a recursive grep over `dist/` and never a fixed module
  path. Verified against the live container: `heapSizeLimit` appears **nowhere**
  in the deployed `dist/`, which is the current failing state this proves out of.
  Covers R4.
- **AE5.** Given the backend is down, when the uptime check next runs, then a
  notification reaches the operator without the operator looking. Covers R3.

### Success Criteria

- No operator action is required to recover from a hang.
- No hang exceeds roughly 5 minutes of downtime.
- Every recovery event and every restart loop produces a notification.
- The four health commits on this branch run in production.

### Scope Boundaries

**In scope.** The Railway deploy target. The entrypoint watchdog. The in-process
health escalation. The Dockerfile source build. External uptime monitoring. An
upstream PR.

**Out of scope.**
- Fixing the `iii` engine's `state::set` hang at its source. The cause sits in a
  third-party engine, the payoff is uncertain, and every layer here makes the
  hang survivable regardless.
- Restructuring the health module's architecture.
- `deploy/fly/`, `deploy/render/`, and `deploy/coolify/`. Each carries the same
  gap in its own `entrypoint.sh`. None is deployed, so none can be verified, and
  unverified copies drift. Recorded as follow-up per the user's decision.
- The MCP 7-tool degradation. It is a symptom of backend downtime, not a separate
  defect. It resolves when the backend stays up, and it needs an MCP server
  restart per host because clients fetch `tools/list` once at connect.

### Dependencies

- Railway CLI, authenticated, linked at `~/rw-agentmemory`.
- `railway ssh` access for in-container verification.
- An uptime-check provider for U5.
- A GitHub account able to open a PR against `rohitg00/agentmemory`. The fork
  `inix-x/agentmemory` already exists as `origin`.

### Outstanding Questions

- **Q1 (deferred, with a resolution path).** The running image is 0.9.28 while
  the Dockerfile ARG pins 0.9.29, so a rebuild on the current Dockerfile would
  bump the app version alongside any entrypoint change. The user parked this
  decision. **U1 dissolves it:** once the image builds from the repo, the app
  version stops being an npm pin and becomes the repo state, so there is no
  separate bump to decide. If U1 is dropped or deferred, Q1 becomes blocking
  again and must return to the user. Do not decide it silently.

### Sources

- Railway docs, healthchecks: "Railway does not monitor the healthcheck endpoint
  after the deployment has gone live." Retrieved via context7, 2026-08-25.
- Upstream issue #1223, heap severity denominator. Fixed locally on this branch,
  absent from the deployed package.
- Live container inspection via `railway ssh`, 2026-08-25.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. RETIRED 2026-08-26. The out-of-process shell watchdog was removed.**
  The original reasoning was that two layers cover each other's blind spots. Two
  things retired it.

  First, the root cause turned out to be **engine process death**, not an
  application hang, and `src/cli.ts` already registers `child.on("exit")` on the
  detached engine carrying the exit code, the signal, and its dying stderr. That
  is a direct event, detected in milliseconds, with no probe, no polling, and no
  false-positive threshold. It replaces ~93 lines of shell with a handler that
  already existed.

  Second, U5 external monitoring is mandatory before either killer may be enabled
  (KTD5), so it exists either way. `livez` is unauthenticated and static, so an
  external check sees exactly what an in-container `curl` sees, **and** survives a
  whole-container wedge the in-container subshell cannot. Railway exposes
  `deploymentRestart` on its public API.

  What is lost, stated rather than glossed: an external monitor needs a Railway
  token held at the provider, `deploymentRestart` takes a per-deploy id so it is a
  small script rather than a bare URL, and an egress failure between monitor and
  Railway can cause a restart the in-container watchdog would not have.
  Governs R1, R5.

- **KTD2. Probe `/agentmemory/livez`, never `/agentmemory/health`.** `livez` is
  unauthenticated (`src/triggers/api.ts:180-192` registers `api::liveness` with no
  `checkAuth`, verified by plain curl returning 200) and returns a static payload.
  `health` returns 503 on a healthy process in production because #1223 is
  unfixed there. Governs R6.

- **KTD3. Hardcode 3111 in the watchdog. Never use `$PORT`.** The application
  never reads `PORT`; `entrypoint.sh` writes `port: 3111` into the iii-http worker
  config directly. `PORT` happens to equal 3111 today, verified in-container. If
  Railway ever injected a different value, `${PORT:-3111}` would poll a dead port,
  never arm, and fail silently. The literal is the more correct choice here.

- **KTD4. SIGTERM first, and know that the flush it buys never happens.** An
  earlier draft justified the grace period as protecting `/data/state_store.db`
  from corruption. **Two separate findings retire that reasoning.** First, the
  engine is a detached process in its own session that owns the store, so a
  single-PID SIGTERM cannot reach it and it dies by namespace teardown either
  way. Second, `shutdown` awaits `indexPersistence.save()` -> `kv.set` ->
  `state::set`, which parks for the engine's 180 s invocation timeout against a
  dead engine, while the grace is 15 s. The hard exit always wins, so the flush
  never completes in the failure this targets.

  The grace stays for the case where the engine is alive and only node is being
  restarted, where the flush does complete. It is not a corruption guard, and
  the plan should not claim it is. Separately, Railway already sends SIGKILL
  after 0 s of draining on every deploy, so the store has survived mid-write
  kills routinely. Governs R2.

- **KTD5. Ship the notification layer first. The once-per-boot cap is weaker than
  it looks.** An earlier draft claimed the cap "bounds a deterministic wedge to
  one restart per deploy." **That is wrong.** The watchdog's `exit 0` / `exit 1`
  are the *subshell's* status, not the container's, and by the time either runs
  PID 1 has already been signalled. The cap bounds one kill per **container**,
  and containers are unbounded up to `restartPolicyMaxRetries`. Every restart is
  a fresh container with a fresh watchdog.

  Measured cycle times, not assumed: the shell watchdog loops in roughly 3.5 to 4
  minutes, reaching `CRASHED` in about 35 to 40 minutes; the in-process layer
  loops in about 5.3 minutes, reaching it in roughly 53 minutes. The `armed`
  guard and the `until curl` loop only close the never-healthy-at-boot case, not
  wedge-after-boot.

  So U5 is not a nicety that makes enabling tidier. It is the only thing that
  makes a restart loop visible before the budget is gone, which is why it gates
  U6. Governs R2, R3.

- **KTD6. Build from source, and accept that it is not reproducible.** An earlier
  draft of this decision claimed the repo carries a `package-lock.json` so
  `npm ci` would be reproducible. **That was wrong.** The lockfile exists only in
  a working tree: `.gitignore:23` excludes it under the comment "Lock files —
  never commit". It is absent from `git archive HEAD`, so `COPY package-lock.json`
  fails every git-based build. Verified by building from a git-only context.

  The build therefore runs `npm install` with no lockfile, which floats every
  caret dependency. That is the cost of the repo's lockfile policy, not a choice
  made here, and it applies equally to the registry install running today. State
  it plainly rather than claiming a reproducibility this build does not have.

  Two further constraints found by building it rather than reasoning about it:
  `node:22-slim` ships npm 10.9.x, whose arborist fails this tree without a
  lockfile (`Cannot read properties of null (reading 'edgesOut')`), so the builder
  upgrades to npm 11 first; and `npm pack` ships only the `files:` allowlist, so
  the runtime install resolves dependencies against the registry and the repo's
  `overrides` must be carried into the runtime manifest explicitly or the CVE pins
  from `91c78e7` never reach the container. Governs R4.

- **KTD7. Evaluate and count before the persist, never after.** In
  `collectHealth`, the KV probe is raced against a 5-second timeout, but the
  subsequent `await kv.set(KV.health, "latest", snapshot)` at `monitor.ts:94` is
  **not raced**. During the real outage `state::set` was timing out at 180000 ms.
  An escalation counter placed after that `await` would never increment during the
  exact failure it targets, because the function would be parked on the persist
  while the 30-second interval spawned more hung collections. The counter lives in
  memory and is incremented before the persist. Governs R5.

- **KTD8. The `overrides` block in the Dockerfile is vestigial.** Its comment
  describes agentmemory resolving `iii-sdk` through a caret range. Both the
  published 0.9.28 and the repo's 0.9.29 pin `iii-sdk` at exactly `0.11.2`,
  verified in-container and in `package.json`. U1 should drop the workaround, and
  must verify the resolved version after the build rather than assume it.

### Assumptions

- ~~The `[iii] Reconnecting` stream is background noise.~~ **RETRACTED
  2026-08-26. This was arithmetically false, and believing it produced the wrong
  root cause above.** Port 49134 is the *engine's* port, so `ECONNREFUSED` there
  means the engine is gone. iii-sdk caps one reconnect attempt at
  `maxDelayMs 30000 x jitter 1.3` = **39 s**. Deployment `a201e22d` booted
  08-24T20:45:00Z and logged attempt **807** at 08-25T12:39:06Z: 57,200 s / 807 =
  **70.9 s per attempt**, above the ceiling, so the stream cannot have begun at
  boot. At the measured 30.6 s/attempt the onset is ~05:48Z, within 11 minutes of
  the `ws` Sender errors.

  **The reconnect counter dates the outage.** Divide elapsed seconds by the
  attempt number and compare against the 39 s ceiling. It is the earliest and
  cheapest signal in the log buffer.
- `tini` exits non-zero when its child dies by signal, so Railway classifies the
  exit as a failure and `ON_FAILURE` restarts. **U2 must verify this**, because
  a clean exit 0 would not trigger a restart and the watchdog would be inert.
- A hang can leave the event loop running. Grounded: the application logged a
  completed smart search at 06:08:19Z, three minutes after the `state::set`
  timeout. This is what makes the in-process layer worth having.

### Implementation Constraints

- Stay on `fix/1223-heap-severity-denominator`. No branch switch, no worktree,
  per `~/.claude/rules/no-branch-switching.md`.
- `deploy/railway/entrypoint.sh` and `deploy/railway/railway.json` are currently
  modified and uncommitted, and those edits are what production runs. U0 commits
  that state before anything stacks on it.
- The entrypoint is POSIX `sh`, not bash. `node:22-slim` provides `dash`.
- Never print `AGENTMEMORY_SECRET` or any `/data/.hmac` content. Handle by path
  and by metadata, per `~/.claude/rules/triggr-credential-handling.md`.

### Sequencing

U0 gates everything. U5 gates the enablement of U2 and U4 per KTD5. U1 gates U3
and U4 reaching production. U8 is independent and may run any time after U3/U4.

**U1 and U2 both edit `deploy/railway/entrypoint.sh`, so they must be
serialized.** Run U1 first: it may relocate the install root, and U2's watchdog is
inserted relative to the final `exec` line that U1 may rewrite. Running them as
parallel branches means whichever is written second clobbers the first.

```
U0 (commit + backup)
   |
   +--> U1 (source build, edits entrypoint.sh)
           |
           +--> U2 (watchdog, edits entrypoint.sh, shipped DISABLED) --+
           |                                                           |
           +--> U3 --> U4 -------------------------------------------- +
                        |                                              |
                        |                          U5 --> U6 (enable) --> U7 (verify)
                        |
                        +--> U8 (upstream PR)
```

---

## Implementation Units

### U0. Commit the deployed state and back up the volume

**Goal.** Establish a known-good rollback point before anything changes.

**Requirements.** R2.

**Files.** `deploy/railway/entrypoint.sh`, `deploy/railway/railway.json`.

**Approach.** Both files are modified and uncommitted, and both are what
production runs. Commit them as-is on the current branch so later changes are
separable. Then back up `/data` using the command in `deploy/railway/README.md`.
Record the current deployment id and image digest so the rollback target is
written down rather than remembered.

**Test Scenarios.**
- `git status --short -- deploy/railway/` reports clean after the commit.
- The backup archive exists locally and is non-empty.
- The recorded digest matches `railway deployment list --json` for the live
  deployment.

**Verification.** `git log -1 --stat -- deploy/railway/` shows both files. The
archive's size is within an order of magnitude of the volume's 0.8 GB.

---

### U1. Build the image from repo source

**Goal.** Make fork-level source changes reach production. Today they cannot.

**Requirements.** R4. Dissolves Q1.

**Files.** `deploy/railway/Dockerfile`, `deploy/railway/entrypoint.sh`,
`.dockerignore` (new). Plus one **Railway service setting**, which is not a file.

**`rootDirectory` is NOT in `railway.json`.** Verified: the file's keys are
`$schema`, `build{builder,dockerfilePath}`, `deploy{...}`, and neither
`serviceManifest` nor `fileServiceManifest` carries `rootDirectory`, yet the
deployment meta reports `rootDirectory: deploy/railway`. It is a dashboard/API
service setting. **Editing `railway.json` will not change the build context.** If
this unit only edits files, the context stays `deploy/railway/`, `src/` never
uploads, and U1 silently no-ops while appearing to succeed. Change the service
setting to the repo root and repoint `dockerfilePath` accordingly.

**Approach.** The current Dockerfile has two `COPY` lines, neither touching
`src/`, and no build step. It installs the published package from npm, which is
why `/opt/agentmemory/src` does not exist in the image and the deployed version
is 0.9.28. Change the build context to the repo root, copy the manifest and
lockfile, run `npm ci`, copy the source, run `npm run build` (`tsdown`), and point
the `agentmemory` bin at the built `dist/cli.mjs`. Prefer a multi-stage build so
dev dependencies do not ship. Add `.dockerignore` to keep `node_modules`,
`.git`, `dist`, and `eval/` out of the upload. Drop the vestigial `overrides`
block per KTD8, then verify the resolved `iii-sdk` rather than assuming.

Note that `dist/` is gitignored, so the image must build it and must never expect
a prebuilt copy.

**The entrypoint is hard-coupled to the npm install layout, and this is the way
U1 fails at boot.** `entrypoint.sh` runs under `set -eu` and does:

```sh
III_CONFIG="/opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml"
cat > "$III_CONFIG" <<'EOF'
```

If U1 moves the install root, that `cat >` writes into a directory that no longer
exists, `set -e` aborts, and the container dies **before the app starts**. Railway
reads that as a failure and retries, so a botched U1 burns all ten retries on the
first deploy and lands in `CRASHED` — precisely the R2 outcome this plan exists to
prevent. `npm run build` is `tsdown && cp iii-config.yaml dist/`, so the config
always lands at `<install-root>/dist/iii-config.yaml`.

Choose one deliberately and write down which: **either** preserve the exact
`/opt/agentmemory/node_modules/@agentmemory/agentmemory/` prefix, **or** update
`III_CONFIG` to the new root. The same applies to the final
`exec gosu "$RUN_AS" agentmemory "$@"`, which resolves `agentmemory` on PATH
through the Dockerfile's symlink into `node_modules/.bin/`. U1 must recreate an
equivalent or that line fails too.

**Test Scenarios.**
- The image builds from a clean context.
- `node -e "require('/opt/agentmemory/.../package.json').version"` inside the
  built image reports 0.9.29, matching the repo.
- `grep -rl heapSizeLimit <install-root>/dist/` inside the image returns at least
  one file. This is AE4. Use a recursive grep: `dist/` is bundled and
  `dist/health/thresholds.js` does not exist.
- **The container boots at all.** `III_CONFIG` resolves and `agentmemory` is on
  PATH. Test this before any deploy, because failure here is a boot loop that
  eats the retry budget.
- The resolved `iii-sdk` is 0.11.2.
- `/agentmemory/livez` returns 200 from the built image.

**Verification.** Build locally first. Only then consider a deploy, which is
gated by U7 and by the destructive-commands confirmation.

---

### U2. REMOVED — out-of-process watchdog

**Deleted 2026-08-26**, superseded by the engine-exit handler (U9) and U5. See
KTD1 for the reasoning. Removed: the ~93-line watchdog block from
`deploy/railway/entrypoint.sh`, four `AGENTMEMORY_WATCHDOG*` variables, their
validation guards, and the tests that exercised them. `curl` **stays** in the
image: `deploy/railway/README.md` documents `railway ssh` plus
`curl http://localhost:3113` as the in-container viewer check, and that path was
used for the 2026-08-26 forensics that corrected the root cause.

### U9. Exit when the engine dies

**Goal.** Turn the actual failure into a process exit, at the place that already
detects it.

**Requirements.** R1, R2. Replaces F1.

**Files.** `src/cli.ts`.

**Approach.** The engine is spawned detached and already has a `child.on("exit")`
handler that captures the exit code, the signal, and up to 16KB of stderr, then
logs under `vlog` and returns. Past a 60-second startup grace, report the death on
`console.error` with that stderr and exit non-zero. Deaths inside the grace keep
the existing path, which renders a better startup message.

Default **on**, unlike the probe-based layers: this acts on a process-exit event,
so there is no threshold to tune and no false positive to trade against. The
engine owns the REST listener, the stream port, and the state store, so nothing
can be served once it is gone. Opt out with `AGENTMEMORY_EXIT_ON_ENGINE_DEATH=0`.

**Test Scenarios.** Death inside the grace keeps the startup path. Death after it
exits non-zero. The opt-out suppresses the exit. The stderr reaches the log.

**Verification.** `npm test`, plus a container run that kills the engine and
observes the exit code.

### U2-original (superseded, kept for the record)

**Goal.** Convert a hang into an exit so the existing restart policy can act.

**Requirements.** R1, R2. Implements F1.

**Files.** `deploy/railway/entrypoint.sh`.

**Approach.** Insert a backgrounded POSIX `sh` loop immediately before the final
`exec gosu`. Capture `$$` first: `exec` preserves the PID, so the shell's PID is
the PID the application will hold. The loop waits for a first successful `livez`
before arming, so a slow BM25 startup backfill can never trigger it, and a boot
that never succeeds is left to Railway's deploy-time healthcheck. After arming, it
polls every 60 seconds; on `WATCHDOG_FAILS` consecutive failures it sends SIGTERM,
waits `WATCHDOG_GRACE` seconds, then sends SIGKILL only if the process survives.
It then exits, which enforces the once-per-boot cap in KTD5 structurally rather
than by a flag.

**Ship it disabled.** Default `AGENTMEMORY_WATCHDOG=0` in this unit. U6 flips it
after U5 exists.

The loop's logic was drafted and exercised during planning, and all five
behaviours passed: never arms against a server that was never up; does not fire
at 2 of 3; fires at exactly 3 of 3; escalates SIGTERM to SIGKILL when SIGTERM is
ignored; a short blip resets the counter without a kill. `ce-work` should re-run
these rather than trust the record.

**Test Scenarios.**
- Never arms when the endpoint has never returned 200.
- Does not fire at `WATCHDOG_FAILS - 1`.
- Fires at exactly `WATCHDOG_FAILS`.
- Escalates to SIGKILL when the target ignores SIGTERM.
- A recovery shorter than the threshold resets the counter and no kill occurs.
- **`AGENTMEMORY_WATCHDOG=0` produces no watchdog process at all.**
- **`tini` exits non-zero when its child is signalled**, so `ON_FAILURE` fires.
  This is the Planning Contract assumption that must be proven, not assumed. A
  clean exit 0 would make the whole unit inert.

**Verification.** `sh -n` for syntax, then the behavioural harness against a
throwaway HTTP server. Confirm the exit code with a container-local run.

---

### U3. Evaluate `kvConnectivity` in the health thresholds

**Goal.** Stop discarding the signal that identifies this exact failure.

**Requirements.** R5. Implements part of F2.

**Files.** `src/health/thresholds.ts`, `test/health-thresholds.test.ts`
(**existing, append only**).

**`test/health-thresholds.test.ts` ALREADY EXISTS** — 174 lines, 9 tests,
carrying the regression coverage for issue #158 and for the #1223 denominator
work in commit `44e5372`. **Append to it. Never overwrite it.** It already
defines a `snap()` fixture helper whose default includes `kvConnectivity`, so
reuse that helper rather than introducing a second fixture.

An earlier draft of this plan claimed no health test file existed. That claim
came from a `find` whose output was swallowed by the `rtk` wrapper, and acting on
it destroyed the file (recovered from `HEAD`). Read a negative search result
through `rtk proxy <cmd>` before trusting it.

**Approach.** `collectHealth` populates `snapshot.kvConnectivity` with `status`,
`latencyMs`, and an optional `error`, using a 5-second race. `evaluateHealth`
checks `connectionState`, `eventLoopLagMs`, `cpu`, and `memory`, and never reads
`kvConnectivity`. Add it: `status === "error"` is critical, with an alert string
matching the existing `snake_case_value` convention used by
`connection_disconnected` and `event_loop_lag_critical_NNNms`. Follow the existing
alert vocabulary rather than inventing a new shape.

**Test Scenarios.**
- A snapshot with `kvConnectivity.status === "error"` evaluates to `critical` and
  carries a `kv_*` alert.
- A snapshot with `status === "ok"` does not add an alert.
- An absent or malformed `kvConnectivity` does not throw and does not evaluate to
  critical. The field is optional in older persisted snapshots, so this is a real
  compatibility path, not a hypothetical.
- The existing heap, CPU, event-loop, and connection assertions still pass.

**Verification.** `npm test`, scoped to the health tests.

---

### U4. Escalate sustained critical health to a process exit

**Goal.** Let the in-process layer act on what it detects, catching a wedge while
the event loop still runs.

**Requirements.** R1, R2, R5. Implements F2.

**Files.** `src/health/monitor.ts`, `test/health-monitor.test.ts` (new file).
`test/health-thresholds.test.ts` **already exists** — see U3. An earlier draft
claimed no health test file existed; that claim was wrong and acting on it
destroyed the file once already.

**Approach.** `registerHealthMonitor` currently ends `collectHealth` with a
persist and a return. Add an in-memory consecutive-critical counter. **Increment
and evaluate it before the `await kv.set(KV.health, "latest", snapshot)` call at
`monitor.ts:94`, never after** — that persist is not raced against any timeout,
and during the real outage `state::set` hung for 180 seconds, so a counter behind
it would never advance during the failure it exists to catch (KTD7). On reaching
the threshold, log a clear reason and exit so `ON_FAILURE` restarts.

Reuse the existing SIGTERM `shutdown` path at `src/index.ts:629-630` rather than
calling `process.exit` directly, so the KV store flushes. Fall back to a hard
exit only if shutdown does not complete within a grace window.

Gate the whole behaviour behind an environment flag, default **off**, matching
U2's disabled-by-default posture and KTD5.

**Test Scenarios.**
- N consecutive critical snapshots trigger exactly one escalation.
- A single healthy snapshot between criticals resets the counter.
- With the flag off, no escalation occurs regardless of snapshot status.
- The counter advances when the persist is slow or rejects. This is the
  regression test for KTD7 and the one most likely to be got wrong.
- Escalation runs the graceful shutdown path, not a bare `process.exit`.

**Verification.** `npm test`. Assert on the escalation decision, not on a real
process exit.

---

### U5. External uptime monitoring

**Goal.** Make an outage and a restart loop reach a human without polling.

**Requirements.** R3. Prerequisite for U6 per KTD5.

**Files.** None in this repo. Configuration lives with the provider. Record the
setup in `deploy/railway/README.md`.

**Approach.** Point an uptime check at
`https://agentmemory-production-0c12.up.railway.app/agentmemory/livez` on roughly
a 5-minute interval, alerting to a channel the user actually reads. The route
needs no auth, verified. This is the only layer that catches a restart loop
burning the retry budget, which is precisely the failure mode the other two
layers can create.

**Test Scenarios.**
- The check reports healthy against the live service.
- A deliberate outage window produces an alert.
- The alert reaches the intended channel, not only the provider's dashboard.

**Verification.** Confirm one real alert end to end. An untested alert path is
not a notification layer.

---

### U6. Enable the watchdog and the escalation

**Goal.** Turn on the killers, once notification exists.

**Requirements.** R2, R3.

**Files.** `deploy/railway/entrypoint.sh` default, or a Railway service variable.

**Approach.** Flip `AGENTMEMORY_WATCHDOG` and U4's flag to on. Prefer Railway
service variables over a Dockerfile default so a rollback needs no rebuild. Do
not perform this unit until U5 has produced one verified alert.

**Test Scenarios.**
- Both layers report armed in the deploy logs.
- A synthetic wedge in a throwaway environment produces exactly one restart.

**Verification.** Read the deploy logs for both arming lines.

---

### U7. Deploy and verify end to end

**Goal.** Prove the whole chain on the live service.

**Requirements.** All.

**Files.** None.

**Approach.** `railway up` from the repo root. **Confirm with the user first**,
per `~/.claude/rules/destructive-commands.md`: show the target project,
environment, service, and the rollback digest from U0. Watch the deployment to a
terminal state; never call it good on `railway status` alone, which reported
`Online` throughout the outage.

**Test Scenarios.**
- AE4: `heapSizeLimit` is present in the deployed `dist/health/thresholds.js`.
- `/agentmemory/livez` returns 200 externally.
- The viewer at `http://127.0.0.1:8899/agentmemory/viewer` returns 200.
- `_proxy/status` shows a small `seconds_since_last_ok`.
- `memory_recall` through MCP returns real observations.
- Both watchdog layers log that they armed.

**Verification.** Run every check above. Per
`~/.claude/rules/verification-no-dismiss.md`, trace any non-green item to ground
before declaring the deploy verified.

---

### U8. Upstream PR to `rohitg00/agentmemory`

**Goal.** Offer the fixes upstream instead of holding them only in the fork.

**Requirements.** R7.

**Files.** The U3 and U4 changes, plus the four existing health commits on this
branch.

**Approach.** `origin` is `inix-x/agentmemory` and `upstream` is
`rohitg00/agentmemory`. Open a PR carrying the `kvConnectivity` evaluation and the
escalation. Reference issue #1223 for the heap work already committed here.
Confirm with the user before opening, per the destructive-commands rule: a PR is
outward-facing.

**Test Scenarios.** Upstream CI passes. The PR description states the failure
mode, the evidence, and the mechanism.

**Verification.** The PR URL is surfaced to the user.

---

## Verification Contract

Repo-specific commands:

```bash
npm test                      # vitest, excludes test/integration.test.ts
npm run test:all              # includes integration
npm run build                 # tsdown -> dist/
sh -n deploy/railway/entrypoint.sh
```

Live-service checks:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://agentmemory-production-0c12.up.railway.app/agentmemory/livez
curl -sS http://127.0.0.1:8899/_proxy/status
# Recursive: dist/ is BUNDLED, so dist/health/thresholds.js does not exist.
cd ~/rw-agentmemory && railway ssh --service agentmemory -- \
  "grep -rl heapSizeLimit /opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/ | wc -l"
```

Quality gates: no unit is done while its own tests fail. No deploy is verified
while any check above is non-green or untraced.

---

## Definition of Done

**Global.**
- A hang recovers with no operator action, within roughly 5 minutes.
- A restart loop produces a notification rather than silence.
- The deployed image contains this branch's health fixes, proven by AE4.
- The upstream PR is open.
- No dead-end or experimental code remains in the diff. A long autonomous run
  accumulates abandoned attempts; declaring done requires removing them.

**Per unit.** Every Test Scenario passes, and every unit that changes runtime
behaviour leaves behind a check that fails if that behaviour breaks.

**Explicitly not done** if: `railway status` alone is used as proof, the
notification path is configured but never fired once, or Q1 is resolved silently
in the event U1 is dropped.
