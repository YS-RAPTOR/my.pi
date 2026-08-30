# Perception

## Health

Check the private daemon selected by the desktop:

```bash
cua-driver call health_report '{}' --socket "$SOCKET"
```

The useful top-level signal is `overall: "ok"`. Treat failed checks as a diagnostic branch rather than continuing with actions.

## Discover windows

List every private-desktop window:

```bash
cua-driver call list_windows '{}' --socket "$SOCKET"
```

Filter by PID when it is known:

```bash
cua-driver call list_windows '{"pid":1234}' --socket "$SOCKET"
```

Visible windows only:

```bash
cua-driver call list_windows \
  '{"on_screen_only":true}' \
  --socket "$SOCKET"
```

Each row includes `pid`, `window_id`, `title`, application name, bounds, and possibly `z_index`. Select one unique target. Array order is not stacking order; when numeric `z_index` values exist, larger values are closer to front.

Example selection:

```bash
cua-driver call list_windows '{}' --socket "$SOCKET" > /tmp/windows.json
jq --arg title "Calculator" \
  '[.windows[] | select(.title | contains($title))]' \
  /tmp/windows.json
```

Continue only when the target choice is unambiguous.

## Snapshot one window

Semantic-only snapshot:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,"include_screenshot":false}' \
  --socket "$SOCKET" > /tmp/window-state.json
```

Semantic and visual snapshot without embedding a large base64 image:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,
    "screenshot_out_file":"/tmp/window.png"}' \
  --socket "$SOCKET" > /tmp/window-state.json
```

Read `/tmp/window.png` with the available image-reading tool.

## Structured elements

Use `.elements`. It contains indexed, enabled controls rather than every passive text node:

```bash
jq '.elements[] |
  {element_token, role, label, value, enabled, selected, frame}' \
  /tmp/window-state.json
```

Common fields:

| Field | Meaning |
|---|---|
| `element_token` | Preferred opaque action address |
| `role` | Accessibility role such as button, entry, link, or menu item |
| `label` | Human-facing name, value, or description |
| `value` | Current control value when exposed |
| `enabled` | Whether the accessibility backend reports operability |
| `selected` | Selection/toggle state when exposed |
| `frame` | Window screenshot coordinates when bounds are usable |
| `parent_index` / `depth` | Accessibility ancestry |

`tree_markdown` also contains passive evidence such as headings and labels. Use it for reading context, not for selecting an action address.

## Filter

The driver's `query` performs a case-insensitive substring projection and preserves matching controls plus ancestors:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,
    "include_screenshot":false,
    "query":"Save"}' \
  --socket "$SOCKET"
```

Compare `returned_element_count` with `total_element_count`.

Use `jq` for structured filtering:

```bash
jq '[.elements[] |
  select(.enabled != false) |
  select((.role // "") | test("button|link|menu item"; "i"))]' \
  /tmp/window-state.json
```

Role filtering is coarse. Prefer a unique observed label and role together.

## Large trees

Bound expensive application trees:

```bash
cua-driver call get_window_state \
  '{"pid":1234,"window_id":5678,
    "include_screenshot":false,
    "max_elements":500,
    "max_depth":20,
    "query":"Preferences"}' \
  --socket "$SOCKET"
```

Caps and query projections do not change the original element indices.

## Desktop capture

Capture the entire private output when window identity is not the question:

```bash
cua-driver call get_desktop_state \
  '{"screenshot_out_file":"/tmp/private-desktop.png"}' \
  --socket "$SOCKET"
```

Prefer a window snapshot for window actions. Desktop coordinates are a separate scope and can target the wrong surface if the desktop changes.

## Freshness

Every `get_window_state` creates a new snapshot and token set. After an action:

1. snapshot again;
2. verify the outcome;
3. select the next control from the new elements;
4. use its new token.

An old token should fail stale rather than silently target a changed control.
