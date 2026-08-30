# Human observation

The viewer is for optional human observation and intervention. Desktop creation does not open it.

## Print a viewer URL

```bash
agent-desktop view "$SESSION" --print
```

The URL selects the requested desktop. Its authorization token is in the URL fragment. Treat the complete URL as sensitive and avoid putting it in logs or durable files.

## Open the viewer

```bash
agent-desktop view "$SESSION"
```

This opens the loopback viewer in the user's normal browser. The viewer can show and interact with the private desktop without moving its windows onto the host compositor.

## When to use it

Open the viewer when:

- the user asks to watch;
- visual interpretation remains ambiguous;
- the user must complete a challenge or consent step;
- the user wants to intervene directly;
- debugging requires observing cursor or focus behavior.

Closing the viewer leaves the desktop running. `agent-desktop destroy` remains the lifecycle endpoint.

## Agent screenshots

For agent-only visual inspection, prefer a file snapshot instead of opening the viewer:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,
    "screenshot_out_file":"/tmp/window.png"}' \
  --socket "$SOCKET"
```

Use `get_desktop_state` only when the whole private output is the intended scope.
