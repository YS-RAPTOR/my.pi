# Recipes

Each recipe assumes a ready desktop and:

```bash
SESSION=$(jq -r .id "$STATE")
SOCKET=$(jq -r .cua_socket "$STATE")
```

## Click a uniquely labelled button

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,
    "include_screenshot":false,
    "query":"Continue"}' \
  --socket "$SOCKET" > /tmp/before.json

TOKEN=$(jq -er \
  '[.elements[] |
    select(.label == "Continue" and .enabled != false)] |
   if length == 1 then .[0].element_token else error("ambiguous") end' \
  /tmp/before.json)

ARGS=$(jq -cn \
  --argjson pid 1234 \
  --arg token "$TOKEN" \
  '{pid:$pid,element_token:$token}')
cua-driver call click "$ARGS" --socket "$SOCKET"
```

Snapshot again and verify the expected next state.

## Fill a field and submit

Snapshot and type:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,
    "include_screenshot":false}' \
  --socket "$SOCKET" > /tmp/form-1.json

TOKEN=$(jq -r \
  '.elements[] | select(.label == "Name") | .element_token' \
  /tmp/form-1.json)

ARGS=$(jq -cn \
  --argjson pid 1234 \
  --arg token "$TOKEN" \
  --arg text "Ada Lovelace" \
  '{pid:$pid,element_token:$token,text:$text}')
cua-driver call type_text "$ARGS" --socket "$SOCKET"
```

Snapshot again, obtain a fresh Submit token, click, then snapshot once more.

## Operate a native application

```bash
agent-desktop exec "$SESSION" --json -- gnome-calculator
cua-driver call list_windows '{}' --socket "$SOCKET"
```

After selecting the calculator window:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,
    "include_screenshot":false}' \
  --socket "$SOCKET"
```

Use fresh labelled button tokens for each key. Re-snapshot after every click.

## Handle a newly opened dialog

Capture windows before the action:

```bash
cua-driver call list_windows '{}' --socket "$SOCKET" > /tmp/windows-before.json
```

Perform the action, then list again:

```bash
cua-driver call list_windows '{}' --socket "$SOCKET" > /tmp/windows-after.json
jq -n \
  --slurpfile before /tmp/windows-before.json \
  --slurpfile after /tmp/windows-after.json \
  '$after[0].windows -
   $before[0].windows'
```

Select and snapshot the new window. Verify its disappearance or expected state after handling it.

## Capture visual evidence

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,
    "screenshot_out_file":"/tmp/evidence.png"}' \
  --socket "$SOCKET" > /tmp/evidence.json
```

Completion: semantic output and the image both correspond to the exact target.

## Full cleanup

```bash
agent-desktop destroy "$SESSION" --json |
  jq -e '.state == "stopped"'
rm -f "$STATE"
```
