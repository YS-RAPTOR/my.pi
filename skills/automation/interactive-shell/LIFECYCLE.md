# Process lifecycle

## Background services and watchers

Start one service per resource. Keep the pane running while its output or endpoint is needed.

Readiness requires an observable signal:

- Expected log text in a fresh pane capture.
- A successful local HTTP or socket probe.
- A file or port created by the process.
- Application-specific health output.

The command remaining alive is not readiness.

**Complete when:** the service passes its application-level readiness check.

## Graceful stop

Send the application's normal interrupt first:

```bash
tmux -L "$SOCKET" send-keys -t "$PANE" C-c
```

Wait briefly and inspect status:

```bash
for _ in $(seq 1 10); do
  [ "$(tmux -L "$SOCKET" display-message -p -t "$PANE" '#{pane_dead}')" = 1 ] &&
    break
  sleep 1
done
tmux -L "$SOCKET" display-message -p -t "$PANE" \
  '#{pane_dead}	#{pane_dead_status}	#{pane_dead_signal}'
```

Use an application exit command or `C-d` when that is the documented graceful path.

**Complete when:** the pane is dead and final output has been captured.

## Forced termination

If graceful shutdown fails, target the recorded pane's process group:

```bash
PANE_PID="$(
  tmux -L "$SOCKET" display-message -p -t "$PANE" '#{pane_pid}'
)"
kill -TERM -- "-$PANE_PID"
sleep 2
if [ "$(tmux -L "$SOCKET" display-message -p -t "$PANE" '#{pane_dead}')" = 0 ]; then
  kill -KILL -- "-$PANE_PID"
fi
```

Verify the PID came from the recorded pane immediately before signalling. Force only when the process must stop and graceful shutdown has failed.

**Complete when:** fresh tmux status reports the pane dead.

## Harvest and remove

Capture final output and status before removing the tmux session:

```bash
tmux -L "$SOCKET" capture-pane -p -S -200 -E - -t "$PANE"
tmux -L "$SOCKET" display-message -p -t "$PANE" \
  '#{pane_dead}	#{pane_dead_status}	#{pane_dead_signal}'
tmux -L "$SOCKET" kill-session -t "$RESOURCE"
```

When no resources remain, stop only the private server:

```bash
if ! tmux -L "$SOCKET" list-sessions >/dev/null 2>&1; then
  tmux -L "$SOCKET" kill-server 2>/dev/null || true
fi
```

With `exit-empty off`, an empty private server may persist. `kill-server` is safe only with the recorded Pi-specific socket.

## Recovery and handoff

Recover resources with:

```bash
tmux -L "$SOCKET" list-panes -a -F \
  '#{session_name}	#{pane_id}	#{pane_dead}	#{pane_dead_status}	#{pane_current_command}	#{pane_current_path}'
```

If a resource must remain running, report:

- `SOCKET`, `RESOURCE`, and `PANE`.
- Command and working directory.
- Current status and readiness evidence.
- How to observe and stop it.

Ownership is transferred only when the receiving user or agent has enough information to supervise and clean it up.
