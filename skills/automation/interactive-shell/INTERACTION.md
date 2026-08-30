# Interaction

## Environment overrides

Pass explicit non-secret environment values with `new-session -e`:

```bash
tmux -L "$SOCKET" new-session ... \
  -e 'NODE_ENV=development' \
  bash -lc "$COMMAND"
```

To remove an inherited variable for the command:

```bash
tmux -L "$SOCKET" new-session ... \
  env -u NODE_OPTIONS bash -lc "$COMMAND"
```

Multiple `-e` and `env -u` arguments compose. Keep secrets out of command lines and tmux's inspectable session environment.

## Literal text and named keys

`send-keys -l` sends text exactly and appends nothing:

```bash
tmux -L "$SOCKET" send-keys -l -t "$PANE" -- 'print("hello")'
tmux -L "$SOCKET" send-keys -t "$PANE" Enter
```

Use tmux key names for keyboard actions:

```bash
tmux -L "$SOCKET" send-keys -t "$PANE" C-c
tmux -L "$SOCKET" send-keys -t "$PANE" C-d
tmux -L "$SOCKET" send-keys -t "$PANE" Escape
tmux -L "$SOCKET" send-keys -t "$PANE" Up Down Left Right
tmux -L "$SOCKET" send-keys -t "$PANE" Tab BTab
```

Capture the pane after each logical input.

**Complete when:** fresh output shows whether the application accepted the input.

## Multiline input

Use a tmux buffer for multiline or large literal input:

```bash
printf '%s' "$TEXT" | tmux -L "$SOCKET" load-buffer -
tmux -L "$SOCKET" paste-buffer -d -t "$PANE"
```

Send `Enter` separately only when the application requires submission. Pasting text containing newlines may execute multiple shell commands; inspect the exact payload first.

**Complete when:** the pane shows the intended text and no unintended submission occurred.

## Shells and REPLs

Start the interpreter itself as the resource command:

```bash
COMMAND='python'
COMMAND='bash --noprofile --norc'
COMMAND='node'
```

Submit one expression or command at a time, then observe before continuing. Use the interpreter's normal exit sequence (`exit`, `C-d`, or equivalent) before forceful termination.

**Complete when:** the prompt or output confirms the interpreter reached the expected state.

## TUIs

The resource starts at 175 columns by 75 rows. Resize when an application needs a different terminal:

```bash
tmux -L "$SOCKET" resize-window -t "$RESOURCE" -x 120 -y 40
```

Capture-pane returns terminal text, not a visual screenshot. For a TUI:

1. Capture before sending keys.
2. Send the smallest named-key sequence.
3. Capture again.
4. Compare the visible state.

Mouse-only or graphics-heavy terminal interfaces may not be controllable reliably through capture-pane.

**Complete when:** the visible terminal state confirms the requested TUI transition.

## Prompts and secrets

Answer only prompts whose meaning is visible and understood. Do not send speculative confirmation keys.

Password input may be invisible in pane capture. Keep secrets out of commands, tmux buffers, captured output, and conversation text; ask the user to use an approved secret-entry path.
