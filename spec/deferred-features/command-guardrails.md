# Command Guardrails

Risky Git writes, privileged commands, and destructive removal require clear user approval. Routine deletion remains recoverable whenever possible.

- Explain the exact operation before approval.
- Keep approvals narrow and visibly scoped.
- Require stronger confirmation for irreversible deletion.

## Sudo

- Require approval for every `sudo` invocation, even when system authentication is cached.
- Show and authorize only the exact command being executed.
- Never expose passwords to the agent, model, logs, or transcript.
- Never reuse one command's approval for another command or turn.

## References

- https://github.com/gotgenes/pi-packages
- https://github.com/Hypabolic/Hypa
- https://github.com/YS-RAPTOR/stratum.pi/blob/main/spec/integrations.md
