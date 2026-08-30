# Actions

## Addressing ladder

Choose the highest available rung:

1. `element_token` from the latest window snapshot;
2. window-local `x,y` from that snapshot's screenshot;
3. desktop coordinates from a fresh desktop capture.

Element tokens are semantic, target-specific, and background-capable. Pixel coordinates are evidence from one image and become stale when layout changes.

Build JSON with `jq -cn` when values are dynamic:

```bash
ARGS=$(jq -cn \
  --argjson pid "$PID" \
  --arg token "$TOKEN" \
  '{pid:$pid,element_token:$token}')
cua-driver call click "$ARGS" --socket "$SOCKET"
```

## Click

Semantic left click:

```bash
cua-driver call click \
  '{"pid":1234,"element_token":"s0000002a:14"}' \
  --socket "$SOCKET"
```

Window-local pixel click:

```bash
cua-driver call click \
  '{"pid":1234,"window_id":5678,"x":420,"y":315}' \
  --socket "$SOCKET"
```

Modified or repeated click:

```bash
cua-driver call click \
  '{"pid":1234,"window_id":5678,"x":420,"y":315,
    "count":2,"modifier":["ctrl"]}' \
  --socket "$SOCKET"
```

## Double-click and context menu

```bash
cua-driver call double_click \
  '{"pid":1234,"element_token":"s0000002a:9"}' \
  --socket "$SOCKET"

cua-driver call right_click \
  '{"pid":1234,"element_token":"s0000002b:3"}' \
  --socket "$SOCKET"
```

Snapshot again between these examples; their tokens intentionally belong to different snapshots.

## Type text

Type into an editable control:

```bash
cua-driver call type_text \
  '{"pid":1234,"element_token":"s0000002a:7",
    "text":"hello world"}' \
  --socket "$SOCKET"
```

For custom-rendered fields that reject the accessibility path, use the field center from the fresh screenshot:

```bash
cua-driver call type_text \
  '{"pid":1234,"window_id":5678,
    "x":380,"y":220,"text":"hello world",
    "delivery_mode":"foreground"}' \
  --socket "$SOCKET"
```

## Set a value

Use `set_value` for non-text controls such as sliders, dropdowns, and toggles when the accessibility backend exposes a value:

```bash
cua-driver call set_value \
  '{"pid":1234,"element_token":"s0000002a:12","value":"75"}' \
  --socket "$SOCKET"
```

Use `type_text` for ordinary text fields.

## Keys and hotkeys

Press one key:

```bash
cua-driver call press_key \
  '{"pid":1234,"window_id":5678,"key":"ENTER"}' \
  --socket "$SOCKET"
```

Target a control first:

```bash
cua-driver call press_key \
  '{"pid":1234,"element_token":"s0000002a:7","key":"TAB"}' \
  --socket "$SOCKET"
```

Send a chord:

```bash
cua-driver call hotkey \
  '{"pid":1234,"window_id":5678,"keys":["ctrl","s"]}' \
  --socket "$SOCKET"
```

## Scroll

Scroll a semantic region:

```bash
cua-driver call scroll \
  '{"pid":1234,"element_token":"s0000002a:18",
    "direction":"down","by":"page","amount":1}' \
  --socket "$SOCKET"
```

Scroll at a window-local point:

```bash
cua-driver call scroll \
  '{"pid":1234,"window_id":5678,
    "x":700,"y":500,
    "direction":"down","by":"line","amount":5}' \
  --socket "$SOCKET"
```

## Drag

Coordinates are window-local screenshot pixels:

```bash
cua-driver call drag \
  '{"pid":1234,"window_id":5678,
    "from_x":220,"from_y":300,
    "to_x":620,"to_y":300,
    "duration_ms":600,"steps":24}' \
  --socket "$SOCKET"
```

## Background and foreground delivery

Input defaults to `delivery_mode: "background"`, which avoids activation where the platform can address the target semantically.

When the response explicitly reports `background_unavailable`, and foreground interaction is appropriate inside this private desktop, retry only that action:

```bash
cua-driver call click \
  '{"pid":1234,"element_token":"s0000002a:14",
    "delivery_mode":"foreground"}' \
  --socket "$SOCKET"
```

Foreground delivery activates the target for the action. It is an escalation, not a default.

## Verification

An action response can report route or dispatch evidence. It does not prove the requested GUI state.

After every action:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,"include_screenshot":false}' \
  --socket "$SOCKET" > /tmp/after.json
```

Check the postcondition:

```bash
jq -e '.elements[] |
  select(.label == "Saved" and .enabled != false)' \
  /tmp/after.json
```

For visual postconditions, write a fresh screenshot and inspect the image.
