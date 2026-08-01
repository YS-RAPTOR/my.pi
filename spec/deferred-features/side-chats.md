# Side Chats

A side chat is a user-interactable DurableAgent presented through Pi UI rather than a separate runtime.

- `btw` starts a fresh side-chat agent.
- `btw-fork <message>` starts one with that message as its context starting point.
- Side chats use normal subagent persistence, controls, profiles, tools, and recovery.
- Any number may exist; normal scheduler limits bound concurrent execution.
- An inject command delivers selected output to the main agent at the end of its turn.

## References

- https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-smart-btw
- @howaboua/pi-smart-btw
