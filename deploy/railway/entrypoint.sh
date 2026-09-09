#!/bin/sh
# agentmemory first-boot entrypoint.
#
# Runs as root so it can:
#   1. Overwrite the npm-bundled iii-config.yaml (which binds 127.0.0.1
#      and uses relative ./data paths) with a deploy-tuned version that
#      binds 0.0.0.0 and uses absolute /data paths.
#   2. chown the platform-mounted /data volume to the runtime user
#      (managed platforms mount volumes root-owned 755 by default).
#   3. Generate the HMAC secret on first boot and persist it to
#      /data/.hmac (chmod 600) so the secret survives restarts.
#
# Then it execs the agentmemory CLI under gosu as the unprivileged
# `node` user.

set -eu

DATA_DIR="${AGENTMEMORY_DATA_DIR:-/data}"
HMAC_FILE="${AGENTMEMORY_HMAC_FILE:-/data/.hmac}"
RUN_AS="node:node"
III_CONFIG="/opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml"

mkdir -p "$DATA_DIR"
chown -R "$RUN_AS" "$DATA_DIR"

# U2 of the memory-reduction ladder. The engine loads every store file into one
# in-memory map at boot and never evicts, so historical stream items stay
# resident for the life of the process. After U1 nothing writes a per-session
# stream group, and the viewer publishes over `stream::send` rather than storing,
# so those files have no reader and no writer.
#
# Retire by RENAME, never delete. The volume has room, so keeping them costs
# nothing and any retirement is undone by moving the directory back. This runs
# before the engine starts and every boot here is a stop-then-start, so the
# engine never sees a file mid-move.
#
# Deliberately flagless (KTD5): a flag would need a second deploy to unset and
# would be one more thing to forget.
retire_stream_files() {
    _src="$1"
    [ -d "$_src" ] || return 0

    _dest="$DATA_DIR/retired/$(date -u +%Y%m%dT%H%M%SZ)"
    _count=0
    _bytes=0

    for _f in "$_src"/*; do
        # Unmatched glob stays literal, and directories are left alone.
        [ -f "$_f" ] || continue
        # Skip the group the dashboard subscribes to, whatever the engine names
        # it on disk. U0 records the real naming; this pattern is deliberately
        # loose because a kept file costs bytes while a wrongly-moved one costs
        # the live feed.
        case "${_f##*/}" in
            *viewer*) continue ;;
        esac

        if [ "$_count" -eq 0 ]; then
            mkdir -p "$_dest" || return 0
        fi
        _size=$(wc -c < "$_f" 2>/dev/null || echo 0)
        if mv "$_f" "$_dest/" 2>/dev/null; then
            _count=$((_count + 1))
            _bytes=$((_bytes + _size))
        fi
    done

    # Idempotent: a boot with nothing to move creates no directory and logs
    # nothing, so this is silent on every deploy after the first.
    if [ "$_count" -gt 0 ]; then
        chown -R "$RUN_AS" "$_dest" 2>/dev/null || true
        echo "agentmemory: retired $_count stream file(s), $_bytes bytes, to $_dest"
    fi
}

retire_stream_files "$DATA_DIR/stream_store"
# U6 of the memory-reduction ladder. The legacy mem:audit scope is over the
# enumeration guard in production: every /agentmemory/audit read of it is a
# 413, its keys are random-suffixed, and the engine has no keys-only list, so
# nothing inside the process can rotate or trim it. New rows go to a monthly
# partition; this moves the one file that can never be read again out of the
# eagerly-loaded store so it stops costing resident bytes.
#
# Retire by RENAME, never delete. Same helper shape as U2's stream retirement:
# runs before the engine, every boot here is a stop-then-start so the engine
# never sees the file mid-move, and any retirement is undone by moving it back.
# Flagless on purpose -- a flag needs a second deploy to unset.
#
# A caller retiring one named file leaves _retire_dest empty and gets its own
# stamped directory and one log line, which is what the audit retires
# above want. A caller retiring many files at once sets _retire_dest to a single
# stamp and reads _retire_count and _retire_bytes after its loop.
retire_matching_file() {
    _dir="$1"
    _name="$2"
    _f="$_dir/$_name"
    [ -f "$_f" ] || return 0

    _dest="${_retire_dest:-$DATA_DIR/retired/$(date -u +%Y%m%dT%H%M%SZ)}"
    mkdir -p "$_dest" || return 0
    _size=$(wc -c < "$_f" 2>/dev/null || echo 0)
    if mv "$_f" "$_dest/" 2>/dev/null; then
        chown -R "$RUN_AS" "$_dest" 2>/dev/null || true
        if [ -n "${_retire_dest:-}" ]; then
            _retire_count=$((_retire_count + 1))
            _retire_bytes=$((_retire_bytes + _size))
        else
            echo "agentmemory: retired $_name, $_size bytes, to $_dest"
        fi
    fi
}

# The exact on-disk name is not pinned anywhere in this repo; U0's endpoint
# reports it. Both plausible spellings are tried and the miss is silent, so a
# wrong guess costs nothing and a right one costs one mv.
retire_matching_file "$DATA_DIR/state_store.db" "mem:audit.bin"
retire_matching_file "$DATA_DIR/state_store.db" "mem_audit.bin"

# U2. The rewrite swaps the six graph scope files for rows the offline emitter
# produced, and the ordering is the whole of it. The engine loads a scope file
# when the file is there, so the originals have to be gone BEFORE it starts;
# the rewritten rows have to go in AFTER it is up, because they go through the
# verbatim row importer and the engine writes its own format (KTD3). One flag
# drives both halves: this retires, and mem::graph-rows-load reads the same
# path once the process is running.
#
# Writing to a retired scope is the cold-start path, not a new one: an empty
# boot creates state_store.db with three files, and every one of production's
# other 2,722 scope files was minted by its own first write.
retire_scope() {
    retire_matching_file "$1" "$(printf '%s' "$2" | sed 's/:/%3A/g').bin"
}

if [ -n "${GRAPH_ROWS_REWRITE_AT_BOOT:-}" ]; then
    for _scope in \
        mem:graph:nodes \
        mem:graph:edges \
        mem:graph:snapshot \
        mem:graph:name-index \
        mem:graph:edge-key \
        mem:graph:node-degree
    do
        retire_scope "$DATA_DIR/state_store.db" "$_scope"
    done
fi

# Lever b' of the memory-reduction loop, generalised. Index persistence mints a
# generation per boot and the manifest-driven GC does not reclaim the prior one,
# so the store grows by about one whole index per redeploy. The selector is
# "every generation the manifest does not name as live", because a list written
# ahead of a boot cannot keep up with a per-boot growth term. The census that
# measured the backlog, the derivation of the on-disk format read below, and the
# deployed result are in "Why the manifest, not a list" in
# docs/investigations/2026-09-06-reclaim-orphaned-generations-rebase.md.
#
# A generation's shards are one scope each and the engine writes one file per
# scope, so the names on disk are
#   mem%3Aindex%3Abm25%3A<family>%3Aidx_<id>_<hex>%3A<NNNNN>.bin
# with <family> bm25 or vectors and <hex> minted with the id. That is why the
# loop below calls retire_matching_file, which takes a filename: neither the hex
# suffix nor the shard number is known before the glob runs.
#
# The live ids are read from the two manifest keys BY NAME, never by grepping
# the file for an id. src/state/index-persistence.ts stores the gc ledger under
# "${manifestKey}:gc" in the manifest's own scope, so mem%3Aindex%3Abm25.bin
# holds the manifest AND both ledgers and names every orphan alongside the live
# one. A grep would refuse exactly what this flag exists to move. A value is read
# as an object or as a JSON-encoded string, because which one the engine writes
# is not pinned by a type in this repo.
#
# ponytail: reads the engine's on-disk scope format directly, pinned by no type
# in this repo. An engine change to the trailer breaks this closed, so it retires
# nothing. Move to a real reader if the engine ever exposes one.
index_live_generations() {
    node -e '
const fs = require("fs");
const raw = fs.readFileSync(process.argv[1]);
// The trailer encodes the body length, so one of its bytes can be 0x7d and the
// last "}" in the file is then not the body brace. The trailer is at most 11
// bytes, so retry from the previous "}" while the candidate stays in that window.
let scope;
for (let i = raw.lastIndexOf(0x7d); i > 0 && i >= raw.length - 12; i = raw.lastIndexOf(0x7d, i - 1)) {
  try { scope = JSON.parse(raw.subarray(0, i + 1).toString("utf8")); break; } catch {}
}
if (scope === undefined) process.exit(1);
const out = [];
for (const key of ["data:manifest", "vectors:manifest"]) {
  const value = scope[key];
  if (value === undefined) continue;
  const manifest = typeof value === "string" ? JSON.parse(value) : value;
  if (manifest && typeof manifest.generation === "string") out.push(manifest.generation);
}
if (out.length === 0) process.exit(1);
process.stdout.write("|" + out.join("|") + "|");
' "$1" 2>/dev/null
}

# Fail closed. With no readable manifest nothing on disk can be told live from
# dead, and retiring the live index costs a full-corpus rebuild, so an absent or
# unparseable manifest moves nothing and says so once.
#
# The two messages differ because the log line is the only signal: absent means a
# fresh volume, present-but-unreadable means the on-disk shape assumption broke.
# The retry above is what makes that second reading true: without it a healthy
# file whose trailer happens to hold a 0x7d reads as a broken one.
# The reader drops stderr, so the caller does the [ -f ] test, not an exit code.
retire_nonlive_index_generations() {
    _manifest="$1/mem%3Aindex%3Abm25.bin"
    if [ ! -f "$_manifest" ]; then
        echo "agentmemory: index generation retire skipped, no mem%3Aindex%3Abm25.bin on disk"
        return 0
    fi

    _live=$(index_live_generations "$_manifest" || true)
    if [ -z "$_live" ]; then
        echo "agentmemory: index generation retire skipped, no live generation read from mem%3Aindex%3Abm25.bin"
        return 0
    fi

    # No subprocess in the examine path. A leaked store is hundreds of files and
    # this runs on the boot path, so the id comes out by parameter expansion and
    # the live test is a case against the pipe-delimited list. The files that are
    # actually retired do cost the four processes retire_matching_file spawns,
    # but the loop examines many and retires few.
    #
    # One stamp for the whole run, computed here rather than per call, so a loop
    # that crosses a second boundary still puts a generation's shards in one
    # directory and putting one back stays a single mv. One summary line, the
    # same shape as retire_stream_files, because a leaked store is 148 shards and
    # a per-file line scrolls out of the log tail before an operator reads it.
    _retire_dest="$DATA_DIR/retired/$(date -u +%Y%m%dT%H%M%SZ)"
    _retire_count=0
    _retire_bytes=0
    # A variable, not the literal: ${_gname%%3A*} parses as the greedy %%
    # operator followed by "3A*", not as % followed by a literal "%3A".
    _sep="%3A"
    for _gf in "$1"/mem%3Aindex%3Abm25%3A*%3Aidx_*%3A*.bin; do
        if [ -f "$_gf" ]; then
            _gname=${_gf##*/}
            _gshardless=${_gname%$_sep*}
            _gen=${_gshardless##*$_sep}
            case "$_live" in
                *"|$_gen|"*) continue ;;
            esac
            retire_matching_file "$1" "$_gname"
        fi
    done

    # Idempotent: a boot with nothing to move creates no directory and logs
    # nothing, so this is silent on every deploy after the first.
    if [ "$_retire_count" -gt 0 ]; then
        echo "agentmemory: retired $_retire_count index shard(s), $_retire_bytes bytes, to $_retire_dest"
    fi
    unset _retire_dest
}

# The literal "true", the same shape as GRAPH_SCOPES_RETIRE_AT_BOOT, so a stray
# value is not read as consent to move an index.
if [ "${INDEX_GENERATIONS_RETIRE_AT_BOOT:-}" = "true" ]; then
    retire_nonlive_index_generations "$DATA_DIR/state_store.db"
fi

cat > "$III_CONFIG" <<'EOF'
workers:
  - name: iii-http
    config:
      port: 3111
      host: 0.0.0.0
      default_timeout: 180000
      cors:
        allowed_origins:
          - "http://localhost:3111"
          - "http://localhost:3113"
          - "http://127.0.0.1:3111"
          - "http://127.0.0.1:3113"
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/state_store.db
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: 3112
      host: 0.0.0.0
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/stream_store
  - name: iii-observability
    config:
      # false, unlike the other three deploy targets: the in-memory OTEL
      # exporter drove heap growth that crashed the container (2026-08-23).
      enabled: false
      service_name: agentmemory
      exporter: memory
      sampling_ratio: 1.0
      metrics_enabled: true
      logs_enabled: true
      logs_console_output: true
EOF
chown "$RUN_AS" "$III_CONFIG"

if [ ! -s "$HMAC_FILE" ]; then
  SECRET="$(openssl rand -hex 32)"
  umask 077
  printf '%s\n' "$SECRET" > "$HMAC_FILE"
  chmod 600 "$HMAC_FILE"
  chown "$RUN_AS" "$HMAC_FILE"
  echo "================================================================"
  echo "agentmemory: generated HMAC secret on first boot"
  echo "AGENTMEMORY_SECRET=$SECRET"
  echo "Copy this value now. It will not be printed again."
  echo "Stored at: $HMAC_FILE (chmod 600)"
  echo "To rotate: delete $HMAC_FILE on the persistent volume and restart."
  echo "================================================================"
fi

AGENTMEMORY_SECRET="$(cat "$HMAC_FILE")"
export AGENTMEMORY_SECRET

exec gosu "$RUN_AS" agentmemory "$@"
