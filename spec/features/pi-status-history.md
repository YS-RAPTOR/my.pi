# Pi Status And History

A Pi widget shows current session activity and searchable agent history without requiring a desktop project panel. It exposes enough status to distinguish progress, waiting, and disruption.

- Show activity, queue, model, context, duration, and usage.
- Show Pi-owned commands and Herdr-owned background shells with their lifetimes.
- Search live and retained conversations.
- Distinguish accepted, delivered, and consumed steering.

## Provider Usage

- Show Codex quota windows, remaining allowance, reset times, and rate-limit state.
- Distinguish session token or cost usage from provider account quota.
- Warn when planned work may exceed available limits.
- Mark unavailable provider data instead of estimating it.

## Unified Exec

Pi shell commands run as controllable sessions.

- Return output normally when a command exits within its initial yield.
- Otherwise expose a session ID for list, read, write, wait, interrupt, and terminate operations.
- Cancelling a wait does not terminate the process.
- Support explicit wake-on-exit behavior.
- Show live sessions in the Pi widget and terminate them when Pi closes.

## References

- https://github.com/YS-RAPTOR/stratum.pi/blob/main/spec/sub-agents/README.md
- https://github.com/iamwrm/pi-unified-exec
- pi-unified-exec
- https://github.com/osolmaz/onurpi/tree/main/packages/codex-usage
