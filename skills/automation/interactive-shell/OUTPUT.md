# Output and status

## Visible pane

Read the current terminal viewport:

```bash
tmux -L "$SOCKET" capture-pane -p -t "$PANE"
```

Use this for routine supervision. It is bounded by the configured pane height.

## Recent history

Read a bounded tail including scrollback:

```bash
tmux -L "$SOCKET" capture-pane -p -S -200 -E - -t "$PANE"
```

For a 200-line page with an offset from the newest line:

```bash
LINES=200
OFFSET=0
tmux -L "$SOCKET" capture-pane -p -S - -E - -t "$PANE" |
  tail -n "$((LINES + OFFSET))" |
  head -n "$LINES"
```

Increase `OFFSET` by `LINES` for the next older page. Stop when the output contains fewer than `LINES` lines. Do not pull the full 100,000-line history into context.

## Fresh status

```bash
tmux -L "$SOCKET" display-message -p -t "$PANE" \
  '#{pane_dead}	#{pane_dead_status}	#{pane_dead_signal}	#{pane_current_command}	#{pane_pid}'
```

Fields:

1. `pane_dead`: `0` while running, `1` after exit.
2. `pane_dead_status`: numeric exit status when available.
3. `pane_dead_signal`: terminating signal when available.
4. `pane_current_command`: foreground command name.
5. `pane_pid`: pane shell/process-group leader.

Status is authoritative; output can look complete while the process is still running.

## List resources

List only the Pi session's private tmux server:

```bash
tmux -L "$SOCKET" list-panes -a -F \
  '#{session_name}	#{pane_id}	#{pane_dead}	#{pane_dead_status}	#{pane_current_command}	#{pane_current_path}'
```

This recovers `RESOURCE` and `PANE` after context loss without inspecting the user's tmux server.

## Bounded wait

Poll state with a deadline:

```bash
TIMEOUT_SECONDS=30
DEADLINE=$((SECONDS + TIMEOUT_SECONDS))
while [ "$(tmux -L "$SOCKET" display-message -p -t "$PANE" '#{pane_dead}')" = 0 ] &&
  [ "$SECONDS" -lt "$DEADLINE" ]; do
  sleep 1
done

tmux -L "$SOCKET" display-message -p -t "$PANE" \
  '#{pane_dead}	#{pane_dead_status}	#{pane_dead_signal}'
```

A deadline expiring is not process failure; it means the resource is still running. Capture output, decide whether to continue waiting, interact, or stop it.

**Complete when:** completion or continued execution is established from fresh status.
