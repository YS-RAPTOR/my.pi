# Process Ownership

Background processes have two ownership tiers:

- User-started background shells are owned by the Herdr workspace.
- The user and agents may fully inspect and interact with Herdr-owned shells.
- Herdr-owned shells survive Pi session replacement.
- Agent-started commands are owned by unified exec and their Pi session.
- Agent-owned commands terminate when their Pi session closes.
- Cancelling or timing out a unified-exec wait does not transfer process ownership.
- The Background tab shows only Herdr-owned shells.
- The Pi widget shows both tiers with their owner and lifetime.

## References

- https://github.com/iamwrm/pi-unified-exec
- https://github.com/gotgenes/pi-packages
- https://github.com/YS-RAPTOR/stratum.pi/blob/main/spec/sub-agents/README.md
