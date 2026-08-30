# Pi sessions and shared tabs

Pi agents share one Vivaldi process and one browser profile through CDP. An agent-browser session isolates daemon state and tab selection; it does not isolate cookies, storage, history, windows, or the browser profile.

## Session identity

Use the Pi session ID on every command:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab tab --json
```

If `PI_SESSION_ID` is unavailable, choose a stable task-specific name and reuse it for the task.

**Complete when:** one session name identifies the task for its full lifetime.

## Strict tab binding

`--pin-tab` binds the session to one CDP target:

- A new pinned session creates a fresh tab instead of adopting the user's active tab.
- User activity and other agents cannot silently change the bound tab.
- A closed bound tab produces `tab_gone` instead of falling back to another tab.
- The pin remains sticky for that named agent-browser session.

List stable tab IDs and CDP target IDs:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab tab --json
```

Labels make task-owned tabs easier to recognize:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  tab new --label docs https://docs.example.com
```

**Complete when:** the session is bound to a deliberate task tab.

## Recovery

On `tab_gone`, inspect the list before recovering:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab tab --json
```

Create a replacement:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  tab new --label task https://example.com
```

Or select a user-identified tab by stable ID, label, or CDP target ID. Never recover by acting on whichever tab happens to be active.

**Complete when:** the replacement target is intentional and freshly snapshotted.

## Concurrent agents

Each Pi agent uses its own named agent-browser session and task tab:

```bash
agent-browser --session pi-agent-a --cdp 9222 --pin-tab \
  tab new --label agent-a https://example.com/a
agent-browser --session pi-agent-b --cdp 9222 --pin-tab \
  tab new --label agent-b https://example.com/b
```

The tabs are separate; authentication and browser profile state remain shared. Workflows requiring different users or isolated cookies need a separate browser profile and are outside this shared-browser skill.

## Cleanup

Close only tabs created by the task:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab tab close
```

Preserve a task tab when it contains useful results or unsaved state. Leave Vivaldi itself running and never use `close --all`.
