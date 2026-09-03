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
      enabled: true
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
