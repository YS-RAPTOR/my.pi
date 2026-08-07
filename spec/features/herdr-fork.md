# Herdr Fork

Maintain a minimal downstream Herdr fork for presentation and TUI-policy changes that cannot be configured or implemented through the socket API.

## Vertical tabs

- Display the active workspace's tabs vertically in the left sidebar.
- Hide the horizontal desktop tab bar and return its row to the terminal viewport.
- Preserve keyboard tab navigation, focus, ordering, scrolling, mouse selection, and active-tab styling.
- Keep tab identity and automatic naming independent of the vertical presentation.

## Restricted TUI actions

Remove these actions from Herdr's built-in context menus:

- Split pane right/down.
- Rename pane.
- Rename tab.
- Rename workspace.

The corresponding keyboard bindings remain disabled in the NixOS configuration. These restrictions apply only to interactive TUI surfaces: pane creation and rename operations remain available through Herdr's CLI and socket API.

## Boundary

Keep the downstream patch limited to vertical presentation and TUI action policy. Automatic tab labels remain owned by the Nix-managed Fish integration, and general Herdr runtime/API capabilities should remain suitable for upstream contribution.
