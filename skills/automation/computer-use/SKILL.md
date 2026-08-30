---
name: computer-use
description: Operate native GUI applications in isolated agent desktops. Use when a task requires launching a graphical app, inspecting windows or controls, clicking, typing, scrolling, handling dialogs, taking screenshots, observing the desktop, or verifying a GUI outcome.
available-if: |
  command -v agent-desktop >/dev/null 2>&1 &&
  command -v cua-driver >/dev/null 2>&1 &&
  command -v jq >/dev/null 2>&1 &&
  printf true
---

# Computer use

Use one private desktop as the control boundary:

```text
agent shell
  ├─ agent-desktop create/exec/destroy
  └─ cua-driver call ... --socket <desktop cua_socket>
                                  │
                                  └─ private Sway desktop
```

`agent-desktop` owns the desktop and its applications. The CUA daemon already runs inside it. Invoke `cua-driver` from the agent shell with the returned socket; `agent-desktop exec` is only for launching GUI applications.

## Workflow

### 1. Create

Choose a unique, stable session ID and save the returned state:

```bash
SESSION="pi-gui-$(date +%s)"
STATE="/tmp/$SESSION.json"
agent-desktop create pi --session-id "$SESSION" --json | tee "$STATE"
```

Extract endpoints when needed:

```bash
SESSION=$(jq -r .id "$STATE")
SOCKET=$(jq -r .cua_socket "$STATE")
```

Continue when the state is `ready` and `cua_socket` is non-null.

### 2. Launch

Launch a desktop application with exact arguments:

```bash
agent-desktop exec "$SESSION" --json -- gnome-calculator
```

Continue when launch returns a positive PID. Discover the actual target window instead of assuming the launch PID owns it.

### 3. Observe

```bash
cua-driver call list_windows '{}' --socket "$SOCKET"
```

Select one exact `(pid, window_id)`, then snapshot it:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,"include_screenshot":false}' \
  --socket "$SOCKET"
```

Use `.elements`, not prose parsing. Select a unique control and retain its latest `element_token`.

### 4. Act

```bash
cua-driver call click \
  '{"pid":1234,"element_token":"s0000002a:14"}' \
  --socket "$SOCKET"
```

Prefer element tokens. Use window-local pixels only for a visible target absent from the accessibility elements.

### 5. Verify

Take a fresh snapshot after every action. Confirm the requested state from the new elements or screenshot. An accepted action only proves dispatch, not task success.

Fresh snapshots invalidate old tokens. Use the new token for the next action.

### 6. Destroy

```bash
agent-desktop destroy "$SESSION" --json
rm -f "$STATE"
```

Finish only when the session reports `stopped`. Destroy the desktop on both success and failure.

## Guardrails

- **Exact target:** identify one window by PID, window ID, and observed title.
- **Snapshot bracket:** observe before and verify after every action.
- **Private socket:** pass this desktop's `cua_socket` on every CUA call.
- **Semantic first:** prefer `element_token`; use pixels from the matching fresh screenshot.
- **Consequences:** obtain normal user confirmation before sending, purchasing, deleting, publishing, or changing accounts.
- **Isolation boundary:** the desktop is graphically isolated but runs as the user and retains ordinary filesystem access.

## References

- Read [desktop lifecycle](DESKTOP-LIFECYCLE.md) for creation, application launch, status, files, and cleanup.
- Read [perception](PERCEPTION.md) for window discovery, accessibility elements, filtering, and screenshots.
- Read [actions](ACTIONS.md) for clicking, typing, keys, scrolling, dragging, and the background/foreground ladder.
- Read [human observation](HUMAN-OBSERVATION.md) when the user needs to watch or intervene.
- Read [recipes](RECIPES.md) for short end-to-end examples.
- Read [troubleshooting](TROUBLESHOOTING.md) when startup, targeting, accessibility, capture, or input fails.
