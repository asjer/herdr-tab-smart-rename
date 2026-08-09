# Runtime safety

Smart Rename fails closed around Herdr compatibility. It never starts, stops, upgrades, downgrades, or restarts a Herdr server.

## Runtime contract

- Herdr 0.8.0+ and Bun 1.1.34+ are required.
- Cardinality is `0` while disabled and exactly `1` per explicitly enabled `HERDR_SOCKET_PATH`.
- `start` holds a per-socket lock for the complete bounded preflight and readiness handshake. A live different-script record or uncertain `ps` result is a conflict, never stale state.
- The child publishes `worker.json` only after snapshot/state initialization and lifecycle handlers are armed.
- `protocol_mismatch` and a missing Herdr binary are permanent. Shutdown takes the per-socket start lock, keeps ownership published until resource work is quiescent, then removes ownership before releasing the lock. If cleanup hangs, a hard deadline exits in under five seconds and leaves stale ownership for the next locked start to verify and clean.
- Socket reconnect uses half-jittered exponential delays from 1 to 60 seconds. Only a valid event resets backoff. One close schedules at most one timer; fatal stream responses stop reconnect.
- Event frames, IDs, labels, pending tab IDs, acknowledgements, command stdout/stderr, and log files have hard bounds.
- Logs reject symlinks/non-regular files and keep one mode-`0600` active file plus one archive, each at most 5 MiB.

## AI contract

AI is off unless `SMART_RENAME_AI_ENABLED=1|true` is explicit. Provider/key presence alone is not consent. Provider secrets are removed from every Herdr, Git, `ps`, and other non-provider subprocess environment.

Provider failures persist only category, count, and retry time. Config/auth/quota cool down for six hours, invalid output for one hour, and transient failures for five to thirty minutes. Provider prose is neither persisted nor printed; operational results use local fixed reasons.

## Read-only per-socket observability

Do not guess which worker belongs to a socket. Set these values explicitly without invoking Herdr:

```sh
socket='/absolute/path/to/the/test/herdr.sock'
state_root='/absolute/path/to/tab-smart-rename/plugin-state'
checkout='/absolute/path/to/the/reviewed/plugin-checkout'
socket_id="$(printf '%s' "$socket" | shasum -a 256 | awk '{print substr($1,1,16)}')"
state_dir="$state_root/sessions/$socket_id"
printf 'socket=%s\nstate=%s\n' "$socket" "$state_dir"

# Read-only ownership/log inspection. Never source these files.
test ! -L "$state_dir" && test ! -L "$state_dir/worker.json"
cat "$state_dir/worker.json" 2>/dev/null || printf 'no ownership record\n'
wc -c "$state_dir/worker.log" "$state_dir/worker.log.1" 2>/dev/null || true
stat -f '%Sp %z %N' "$state_dir/worker.json" "$state_dir/worker.log" "$state_dir/worker.log.1" 2>/dev/null || true

# The direct status action is read-only and uses the same exact socket hash/script identity.
HERDR_SOCKET_PATH="$socket" \
HERDR_PLUGIN_STATE_DIR="$state_root" \
HERDR_PLUGIN_ROOT="$checkout" \
bun "$checkout/src/cli.ts" status
```

A healthy enabled socket has one exact live PID/script record, mode `0600` files, near-zero idle CPU, near-zero idle log growth, and no repeated fatal/provider messages. A different-script record, uncertain process identity, multiple matching PIDs, symlink, non-regular log, or cap violation is a stop/refuse condition.

Global `pgrep` is only a secondary count; it cannot establish per-socket ownership:

```sh
pgrep -fl 'tab-smart-rename.*worker.ts' || true
```

## Exact stop and verification

Stopping the plugin worker does **not** stop the Herdr server. For the explicitly selected socket/state/check-out above:

```sh
HERDR_SOCKET_PATH="$socket" \
HERDR_PLUGIN_STATE_DIR="$state_root" \
HERDR_PLUGIN_ROOT="$checkout" \
bun "$checkout/src/cli.ts" stop

HERDR_SOCKET_PATH="$socket" \
HERDR_PLUGIN_STATE_DIR="$state_root" \
HERDR_PLUGIN_ROOT="$checkout" \
bun "$checkout/src/cli.ts" status

test ! -e "$state_dir/worker.json"
```

If `stop` reports a record conflict or the ownership file remains, do not delete it blindly and do not start another worker. Preserve the record/logs, inspect its exact PID and command, and escalate. Never restart a Herdr server as plugin rollback; stopping a server exits pane processes.

## Canary acceptance

Use only a disposable named Herdr 0.8.0 session with a unique socket/state root, after separate approval.

1. Confirm CLI/test-server versions and protocol match.
2. Verify the exact installation/ref syntax from the installed Herdr 0.8.0 help before using it; this document intentionally does not assert uncanaried Herdr CLI syntax.
3. Start once; verify one exact worker for the disposable socket.
4. Start again after a delayed preflight; verify idempotence and still one worker.
5. Verify a default tab rename, manual label preservation, AI-off zero-call behavior, reconnect/backoff, fatal cleanup, file permissions/caps, and near-zero idle CPU/log growth.
6. Stop the worker with the exact command above; verify `status`, PID exit, and ownership removal.
7. Only then stop the disposable server and verify its socket is gone.

Never point the canary at `default`, `dac`, `portal`, or `devtools`.

## Rollback and fork pin

Before canary/install, record both exact SHAs:

```sh
reviewed_sha="$(git -C "$checkout" rev-parse HEAD)"
previous_good_sha='<previous reviewed SHA>'
printf 'reviewed=%s\nprevious=%s\n' "$reviewed_sha" "$previous_good_sha"
git -C "$checkout" status --short
git -C "$checkout" show --no-patch --oneline "$reviewed_sha"
git -C "$checkout" show --no-patch --oneline "$previous_good_sha"
```

Rollback sequence:

1. Stop only the selected Smart Rename worker and verify zero ownership/PID for that socket.
2. Leave Smart Rename off; do not restart Herdr.
3. Preserve `worker.json`, `worker.log`, `worker.log.1`, and state when stop/identity was abnormal. Remove nothing blindly.
4. Reinstall the exact `previous_good_sha` only through the Herdr 0.8 mechanism whose syntax was verified in the disposable canary.
5. Verify the installed registry/source resolves to that exact SHA before considering a later start.

The durable source is `asjer/herdr-tab-smart-rename`. Never pin a moving branch, update the live registry before canary acceptance, or present an unverified Herdr install flag as established syntax.
