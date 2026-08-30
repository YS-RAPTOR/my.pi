---
name: interactive-shell
description: Run and control persistent interactive or background terminal processes with tmux. Use for REPLs and TUIs, dev servers or watchers, commands that need later stdin or keys, long-running jobs requiring incremental output, process status or exit monitoring, and explicit cancellation.
available-if: |
  command -v tmux >/dev/null 2>&1 &&
  command -v bash >/dev/null 2>&1 &&
  printf true
---

# Interactive shell

Use ordinary Bash for commands that can complete in one call. Use a private tmux resource when the process must survive across tool calls, receive later input, expose incremental output, or be stopped deliberately.

## 1. Define the resource

Use one private tmux server per Pi session and one tmux session per process:

```bash
SOCKET="pi-shell-${PI_SESSION_ID}"
RESOURCE="shell-$(date +%s)-${RANDOM}"
CWD="/absolute/working/directory"
COMMAND='npm run dev'
```

Shell variables do not persist between Pi Bash calls. Print and record `SOCKET`, `RESOURCE`, and the returned `PANE`, then re-declare those exact values at the start of every later call. Use an explicit absolute working directory and exact command. Keep secrets out of command strings and tmux environment arguments.

Read the environment-overrides section in [INTERACTION.md](INTERACTION.md) before opening when the command needs variables set or removed.

**Complete when:** the resource identity, working directory, and command are explicit.

## 2. Open

Initialize the private server, retain exited panes, and start the command detached:

```bash
tmux -L "$SOCKET" -f /dev/null start-server \; \
  set-option -s exit-empty off \; \
  set-option -g history-limit 100000 \; \
  set-option -g extended-keys on \; \
  set-option -g extended-keys-format csi-u \; \
  set-option -gw remain-on-exit on \; \
  set-option -gw remain-on-exit-format ''

PANE="$(
  tmux -L "$SOCKET" new-session -d -P -F '#{pane_id}' \
    -s "$RESOURCE" -c "$CWD" -x 175 -y 75 \
    bash -lc "$COMMAND"
)"
printf 'SOCKET=%q\nRESOURCE=%q\nPANE=%q\n' "$SOCKET" "$RESOURCE" "$PANE"
```

A valid pane ID starts with `%`. Treat startup as unverified until the pane output and status have been observed.

**Complete when:** the concrete socket, session, and pane values are recorded and tmux can inspect the pane.

## 3. Observe

Read the visible terminal:

```bash
tmux -L "$SOCKET" capture-pane -p -t "$PANE"
```

Inspect fresh process state:

```bash
tmux -L "$SOCKET" display-message -p -t "$PANE" \
  '#{pane_dead}	#{pane_dead_status}	#{pane_dead_signal}	#{pane_current_command}	#{pane_pid}'
```

`pane_dead=0` means running. `pane_dead=1` means completed; read the exit status and signal rather than inferring success from terminal text.

Read [OUTPUT.md](OUTPUT.md) for bounded history, pagination, listing, polling, and completion state.

**Complete when:** the latest visible output and current process state are known.

## 4. Interact or wait

Send literal text without an implicit Enter:

```bash
tmux -L "$SOCKET" send-keys -l -t "$PANE" -- 'literal input'
```

Send named keys separately:

```bash
tmux -L "$SOCKET" send-keys -t "$PANE" Enter
tmux -L "$SOCKET" send-keys -t "$PANE" C-c
tmux -L "$SOCKET" send-keys -t "$PANE" Up Enter
```

Read [INTERACTION.md](INTERACTION.md) before multiline input, REPLs, TUIs, prompts, or key chords. Use [LIFECYCLE.md](LIFECYCLE.md) for readiness checks, bounded waiting, background services, interruption, and forced termination.

After every input, take a fresh capture and status. An accepted key dispatch does not prove the process handled it.

**Complete when:** fresh output or state proves the intended interaction or wait result.

## 5. Harvest

When the pane completes, capture the needed tail before removing it:

```bash
tmux -L "$SOCKET" capture-pane -p -S -200 -E - -t "$PANE"
tmux -L "$SOCKET" display-message -p -t "$PANE" \
  '#{pane_dead}	#{pane_dead_status}	#{pane_dead_signal}'
```

Report the command, relevant output, exit code or signal, and any generated artifact paths. Keep output excerpts bounded to what supports the result.

**Complete when:** the process outcome and required evidence have been retained outside tmux.

## 6. Clean up

Remove the completed resource:

```bash
tmux -L "$SOCKET" kill-session -t "$RESOURCE"
```

For a running resource, follow the graceful-to-force ladder in [LIFECYCLE.md](LIFECYCLE.md) first. Leave a resource running only when the user asked for persistence or the parent task still needs it; report its socket, session, pane, command, and working directory.

**Complete when:** the resource is removed or its continued ownership is explicit.

## Guardrails

- Always pass `-L "$SOCKET"`; never use or inspect the user's default tmux server.
- Use one tmux session per process so status, input, and cleanup have one exact target.
- Capture bounded output; expand history only when the missing evidence requires it.
- Send literal text and named keys separately.
- Verify readiness from output or an application probe, not elapsed time alone.
- Preserve completed panes until exit status and useful output are harvested.
- Target only the recorded pane, process group, session, and private socket.
- A background process remains the agent's responsibility until removed or explicitly handed off.
