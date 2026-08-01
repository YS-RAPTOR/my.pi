# Durable Subagents

Subagents retain one identity and conversation across attempts, restarts, and recoverable disruptions. Users can run, steer, interrupt, and continue them without losing prior context.

- Support immediate foreground work and bounded queued work.
- Use ownership leases and heartbeats to detect stale attempts and disruption.
- Never resume a deliberate interruption automatically.
- Offer recoverable isolated-worktree execution.
- Use the same lifecycle for user-interactable side chats.

## References

- https://github.com/YS-RAPTOR/stratum.pi/blob/main/spec/sub-agents/README.md
- https://github.com/nicobailon/pi-subagents
- https://github.com/tintinweb/pi-subagents
- https://github.com/gotgenes/pi-packages
