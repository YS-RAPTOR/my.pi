# Desktop lifecycle

## Responsibilities

`agent-desktop` creates a private Sway session containing Wayland, D-Bus, AT-SPI, PipeWire, portals, CUA, and VNC.

The CUA client stays in the agent shell:

```bash
cua-driver call TOOL JSON --socket "$SOCKET"
```

Applications enter the desktop through:

```bash
agent-desktop exec "$SESSION" --json -- COMMAND ARG...
```

## Create

```bash
SESSION="pi-gui-$(date +%s)"
STATE="/tmp/$SESSION.json"
agent-desktop create pi --session-id "$SESSION" --json | tee "$STATE"
```

Important fields:

| Field | Use |
|---|---|
| `id` | Every `agent-desktop` lifecycle command |
| `state` | `ready` and `active` accept launches |
| `runtime_dir` | Temporary logs, downloads, and service endpoints |
| `cua_socket` | Every `cua-driver call` |
| `control_socket` | Internal application-launch endpoint |

`create` waits for readiness. A successful return with `state: "ready"` means the desktop services and CUA endpoint passed startup checks.

Inspect existing sessions:

```bash
agent-desktop list --json
agent-desktop status "$SESSION" --json
```

## Launch applications

Arguments are passed exactly:

```bash
agent-desktop exec "$SESSION" --json -- zenity \
  --entry \
  --title "Private prompt"
```

The command returns immediately with:

```json
{"arguments":["zenity","--entry","--title","Private prompt"],"pid":1234}
```

The application has no terminal input. Its output is written to the session's application logs. Use a shell explicitly only when shell evaluation is the intended behavior:

```bash
agent-desktop exec "$SESSION" --json -- \
  bash -lc 'exec my-gui-app --mode "$1"' _ demo
```

Avoid wrapping ordinary argument arrays in a shell.

## Session states

| State | Meaning |
|---|---|
| `starting` | Services are still becoming ready |
| `ready` | Desktop is healthy with no ordinary application running |
| `active` | At least one launched application is running |
| `stopping` | Teardown is underway |
| `failed` | The supervisor or a critical service failed |
| `stopped` | Runtime resources were reclaimed |

`ready` and `active` are both launchable.

## Temporary and persistent files

Applications run as the ordinary Unix user. They can access ordinary user files unless the application itself restricts access.

Session-owned paths disappear on destroy:

- desktop-local cache, config, data, and state
- application logs
- service sockets

Copy any required artifact to an explicitly persistent path before teardown:

```bash
RUNTIME=$(jq -r .runtime_dir "$STATE")
cp -- "$RUNTIME/downloads/report.pdf" "$PWD/report.pdf"
```

## Logs

Inspect the owning unit:

```bash
journalctl --user -u "agent-desktop-$SESSION.service" --no-pager -n 100
```

Inspect application logs while the session exists:

```bash
RUNTIME=$(jq -r .runtime_dir "$STATE")
find "$RUNTIME/logs" -maxdepth 1 -type f -print
```

## Cleanup

```bash
agent-desktop destroy "$SESSION" --json
agent-desktop status "$SESSION" --json
rm -f "$STATE"
```

Destroy is successful when the resulting state is `stopped`. It terminates applications, services, temporary state, and private endpoints belonging to that session.
