# Workflow Worktree Handoff

Workflow calls can produce durable branch artifacts that later calls inspect, compare, merge, cherry-pick, or synthesize.

- Preserve branch and worktree identity between calls.
- Make handoffs explicit in workflow history.
- Never merge or delete results implicitly.

## References

- https://github.com/YS-RAPTOR/stratum.pi/blob/main/spec/workflows/README.md
- https://github.com/YS-RAPTOR/stratum.pi/blob/main/spec/sub-agents/README.md
- https://github.com/gotgenes/pi-packages
- https://github.com/QuintinShaw/pi-dynamic-workflows
