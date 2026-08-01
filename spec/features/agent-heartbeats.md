# Agent Heartbeats

An agent can create a temporary heartbeat when its current task requires periodic checks, and stop it when no longer needed.

- Give each heartbeat an owner, interval, check instruction, and optional expiry.
- Show active heartbeats and their next run in the Pi widget.
- Wake only the owning agent and coalesce ticks while it is busy.
- Let the agent or user pause, resume, edit, or stop it.
- Stop it when its owner is deleted or its expiry is reached.
- Never create heartbeats automatically or expose general scheduled execution.

## References

- https://github.com/YS-RAPTOR/stratum.pi/blob/main/spec/sub-agents/README.md
