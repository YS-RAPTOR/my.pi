# Review Flow

The user, implementation agent, and review agent share one durable review flow.

- Use colocated Jujutsu/Git for attributable user, agent-turn, and experiment changes.
- Use Hunk to review current changes, change ranges, branches, and commits.
- Allow users and agents to move selected work between Jujutsu changes.
- Use Impeccable surfaces for rendered visual review.
- Support specifications and hosted-review annotations.
- Preserve comments, responses, resolutions, and review readiness across turns.
- Return accepted feedback to the owning implementation agent.
- Track which changes address each annotation.
- Keep GitHub push, PR, merge, and discard actions explicit.

## References

- https://github.com/modem-dev/hunk
- https://github.com/backnotprop/plannotator
- https://github.com/jj-vcs/jj
- https://github.com/YS-RAPTOR/stratum.pi/blob/main/spec/integrations.md
