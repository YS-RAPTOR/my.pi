# Editor-Agent Handoff

Users can compose prompts from selected code and editor context. When they edit files during agent work, the next handoff identifies those changes clearly and attributably.

- Preview context before sending a prompt.
- Distinguish user edits from agent edits.
- Let users control when edit context is handed off.

## User-Edit Injection

- Automatically inject attributable user edits at the next safe turn boundary when enabled.
- Allow selected changes to be attached explicitly as a named prompt reference.
- Preview the exact diff and context before delivery.
- Never interrupt an active turn unless the edits are sent as steering.
- Mark delivered context so it is not injected repeatedly.

## References

- https://github.com/anomalyco/opencode
