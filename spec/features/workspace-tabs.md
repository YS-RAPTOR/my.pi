# Workspace Tabs

Each project workspace has four tab roles:

| Role | Instances | Purpose |
|---|---:|---|
| Agent | One | Pi |
| Editor | One | Neovim |
| Shell | One or more | Fish and other commands |
| Background | One | Detached shell manager |

Agent and Editor are Fish sessions with a preferred foreground application.

## Routing

- `pi [args]` routes to Agent.
- If Pi is working, focus it and ignore the arguments.
- If Pi is absent or settled, close it if needed and start a new session with the arguments.
- `nvim [args]` routes to Editor.
- If Neovim exists, forward compatible arguments over RPC and focus it.
- Every other user-entered command runs in an idle Shell, or a new Shell if all are busy.
- Routed commands inherit the originating working directory.
- Commands launched internally by Pi or Neovim are not routed.

## Backgrounding

A Herdr keybind can detach any Shell tab into Background without stopping its PTY or process tree. Another idle Shell is focused, or a new one is created in the same directory.

Background shows only Herdr-owned shells. It supports viewing output, sending input, interrupting, terminating, reattaching, and removing completed shells. Exited shells retain their output and status until removed.

## Presentation

A Herdr fork displays tabs vertically in its left sidebar and hides the horizontal tab bar.

- Agent, Editor, and Background use fixed labels.
- Idle shells are numbered: `Shell 1`, `Shell 2`, and so on.
- A busy shell displays only its foreground command, such as `lazygit` or `npm test`.
- Its numbered label returns when the command exits.
- Stable shell IDs remain internal for routing and restoration.

Routing and background state follow the Herdr workspace boundary defined in `../foundations/workspace-boundary.md`.

## References

- https://github.com/ogulcancelik/herdr
- https://github.com/iamwrm/pi-unified-exec
