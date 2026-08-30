# Troubleshooting

## Discover the live contract

When an argument is uncertain, query the private daemon instead of guessing:

```bash
cua-driver list-tools --socket "$SOCKET"
cua-driver describe click --socket "$SOCKET"
```

Use the returned schema for the installed version.

## Desktop creation fails

Inspect the retained state and owning user unit:

```bash
agent-desktop list --all --json
agent-desktop status "$SESSION" --json
journalctl --user -u "agent-desktop-$SESSION.service" --no-pager -n 150
```

The state `message` contains the supervisor's failure summary. Destroy failed sessions after collecting diagnostics.

## CUA call cannot connect

Re-read the current session:

```bash
agent-desktop status "$SESSION" --json
```

Confirm:

- state is `ready` or `active`;
- `cua_socket` is non-null;
- the exact socket from that session is passed to `--socket`;
- the session has not expired or been destroyed.

## Health is degraded

```bash
cua-driver call health_report '{}' --socket "$SOCKET"
```

Use failing check names and messages as the diagnostic source. The private desktop starts its own D-Bus and AT-SPI services, so host-daemon status does not describe this session.

## No target window

Applications can take time to map a window or can delegate it to another process:

```bash
for _ in $(seq 1 40); do
  cua-driver call list_windows \
    '{"on_screen_only":true}' \
    --socket "$SOCKET" > /tmp/windows.json
  jq -e '.windows | length > 0' /tmp/windows.json && break
  sleep .1
done
```

Search by observed title and application name rather than assuming the launch PID owns the window.

## Empty or degraded elements

If `get_window_state` returns `degraded: true`:

1. inspect `degraded_reason`;
2. check `health_report`;
3. wait briefly and re-snapshot once for a lazily populated application tree;
4. capture a screenshot and use a pixel action only when the visual target is unambiguous.

An empty accessibility result does not prove that the window has no controls.

## Stale element token

Errors such as `stale_element_token`, `snapshot_id_required`, or “no cached AX state” mean the address no longer belongs to the latest snapshot.

Call `get_window_state` again and use the new `element_token`. Never repair or edit a token manually.

## Background action refused

An explicit `background_unavailable` response means the platform could not safely target that action without activation.

After confirming the action is appropriate inside the private desktop, retry only that action with:

```json
{"delivery_mode":"foreground"}
```

Refresh state before retrying so its token or coordinates remain current.

## Action reports success but UI did not change

Dispatch success is not task completion.

1. take a fresh semantic and visual snapshot;
2. confirm the target was exact;
3. check whether a dialog or new window appeared;
4. check whether the control was disabled, obscured, or virtualized;
5. retry through the next justified rung: fresh token, fresh window-local pixel, then foreground delivery.

Stop when the next rung would be ambiguous or consequential.

## Screenshot unavailable

Use `screenshot_out_file` with an absolute path. If window capture reports an identity or capture error:

1. refresh `list_windows`;
2. confirm the `(pid, window_id)` still exists;
3. retry one exact window capture;
4. use `get_desktop_state` only if whole-desktop scope is acceptable;
5. open `agent-desktop view "$SESSION"` when human observation is required.

## Application exits unexpectedly

Inspect:

```bash
RUNTIME=$(jq -r .runtime_dir "$STATE")
find "$RUNTIME/logs" -maxdepth 1 -type f -print
journalctl --user -u "agent-desktop-$SESSION.service" --no-pager -n 150
```

An ordinary application failure should leave the desktop usable. A critical service failure changes the session to `failed`.

## Cleanup fails

Retry the public lifecycle endpoint:

```bash
agent-desktop destroy "$SESSION" --json
agent-desktop status "$SESSION" --json
```

If resources remain, preserve the status and journal output before changing system state.
