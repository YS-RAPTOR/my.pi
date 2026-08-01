# Sub-Agent Runtime Reference Comparison

This document compares the focused runtimes studied for the Stratum.pi
sub-agent specification.

- `pi-subagents` supplies the strongest detached durability and cold revival.
- `@tintinweb/pi-subagents` supplies the richest interactive UI and definition
  surface.
- `@gotgenes/pi-subagents` supplies the cleanest typed extension service and
  companion-provider architecture.
- Stratum.pi combines the desired capabilities while remaining an in-process
  runtime.

## Core Runtime

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Child architecture | Detached processes | In-process sessions | In-process sessions | In-process sessions |
| Foreground agents | Yes | Yes | Yes | Yes |
| Background agents | Yes | Yes | Yes | Yes |
| Runs after Pi exits | Yes | No | No | No |
| Persistent transcript | Yes | Optional | Yes | Always |
| Typed service | Event RPC | Event RPC | Direct typed service | Versioned typed service |
| Nested agents | Optional | Prohibited | Prohibited | Prohibited |
| Rich UI | Limited | Strong | Moderate | Strong |

## Completed Continuation

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Continue a completed child | Yes | Yes | Yes | Yes |
| Preserve conversation | JSONL | Live session | Live session | JSONL |
| Reuse completed live session | No | Yes | Yes | No, fresh lifecycle per attempt |
| Reconstruct evicted session | Yes | No | No | Yes |
| Stable logical agent ID | No | Yes | Yes | Yes |
| New attempt identity | New run ID | No | No | Yes |
| Change model on continuation | Yes | No | No | Yes |
| Revalidate current policy | New process only | No | No | Yes |

## Foreground And Background Resume

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Resume foreground child | Partial | Yes | Yes | Yes |
| Resume background child | Yes | Yes | Yes | Yes |
| Same API for both modes | No | Mostly | Mostly | Yes |
| Choose continuation mode | No | No | No | Yes |
| Resume while already running | Special async path | Unsafe | Unsafe | Rejected |
| Background admission queue | Yes | Yes | Yes | Yes |

## Reload And Restart

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Resume after extension reload | Background only | No | No | Yes |
| Resume after parent restart | Background only | No | No | Yes |
| Resume after process crash | Background only | No | No | Yes |
| Reconstruct manager index | Background only | No | No | Yes |
| Restore old agent ID | Background only | No | No | Yes |
| Manual resume policy | Yes | Live only | Live only | Yes |
| Automatic resume policy | No | No | No | Yes |
| Resume ownership claim | Weak | No | No | Yes |
| Persisted resume-error diagnostics | No | No | No | Yes |

## State Resume

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Resume completed | Yes | Yes | Yes | Yes |
| Resume failed | Yes with valid session | Yes while retained | Yes while retained | Yes with valid session |
| Resume interrupted | Yes | No explicit state | No explicit state | Yes |
| Resume after system disruption | Background only | No | No | According to policy |
| Preserve partial result | Yes | Yes | Yes | Yes |
| Explicit resumability | State-derived | No | No | Authority-controlled |

## Parallel Children

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| First-class parallel run | Yes | Notifications only | No | Orchestrator owned |
| Resume selected child | By index | By child ID | By child ID | By stable agent ID |
| Resume child independently | Yes | Yes | Yes | Standalone agents only |
| Deterministic workflow replay | No | No | No | Out of scope |

## Steering And Chat

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Steer foreground child | No | Technically | Technically | Yes |
| Steer background child | Yes | Yes | Yes | Yes |
| Queue before session ready | Partial | Yes | Yes | Durable |
| Abort current tool when steering | No | No | No | No |
| Steering becomes user message | Yes | Yes | Yes | Yes |
| Durable steering request | Partial | No | No | Yes |
| Delivery acknowledgement | Acceptance only | No | No | Yes |
| Consumption acknowledgement | No | No | No | Yes |
| Conversation viewer | No live chat | Interactive | Read-only | Interactive or workflow read-only |
| Chat composer | No | Uses steering | No | Standalone agents only |

## Interrupt Controls

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Interrupt foreground | Yes | Abort | Abort | Yes |
| Interrupt background | Yes | Abort | Abort | Yes |
| User interrupt never auto-resumes | No policy | No policy | No policy | Yes |
| System disruption follows resume policy | No | No | No | Yes |
| Recoverable interrupt with follow-up | Partial async path | No | No | Yes |
| Persist pending follow-up | No | No | No | Yes |
| Recover operation after crash | No | No | No | Yes |

## Models

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Explicit model at spawn | Yes | Yes | Yes | Yes |
| Require explicit model and thinking together | No | No | No | Yes |
| Parent-model fallback | Yes | Yes | Yes | Yes |
| Scoped-model enforcement | Yes | Partial | No | Yes |
| Change model during live tool | No | No | No | No |
| Change model on interrupt follow-up | No | No | No | Yes |
| Change model on revival | Yes | No | No | Yes |
| Persist model per attempt | Yes | Partial | Partial | Yes |

## Retention

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Live completed session | Process ended | About 10 minutes | About 10 minutes | Disposed; read-only projection cached 15 minutes |
| Durable agent metadata | Background only | No | No | Yes |
| Durable attempt history | Background only | No | No | Yes |
| Durable transcript | Yes | Optional | Yes | Always |
| Lazy session reopening | Yes | No | No | Yes |
| Configurable retention | Artifacts | No | No | Yes |

## Worktrees

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Isolated worktree | Yes | Yes | Companion | Yes |
| Retain branch | No | Yes | Yes | Yes |
| Retain unfinished directory | No | No | No | Yes |
| Retain across restart | No | No | No | Yes |
| Reuse valid directory | No | No | No | Yes |
| Recreate identical path | No | No | No | Yes |
| Restore files from branch | No | Branch only | Branch only | Yes |
| Recover dirty crash state | Patch-oriented | Unspecified | Unspecified | Yes when directory or snapshot survives |
| Recovery patch fallback | Yes | No | No | Yes |
| Automatic merge | No | No | No | No |

## Definitions And Filtering

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Markdown definitions | Extensive | Extensive | Focused | Extensive |
| Model and thinking | Yes | Yes | Yes | Yes |
| Built-in tool allowlist | Yes | Yes | Yes | Yes |
| Extension allowlist | Yes | Yes | No | Yes |
| Extension-tool allowlist | Yes | Yes | No | Yes |
| Tool denylist | Yes | Yes | No | Yes |
| Skills | Yes | Yes | Inherited only | Yes |
| Persistent memory | Yes | Yes | No | Yes |
| Locked definition fields | Precedence rules | Frontmatter authoritative | Frontmatter authoritative | Explicit locks |
| Exact child tool filtering | Yes | Yes | Yes | Yes |
| Child orchestration prohibited | Optional | Yes | Yes | Yes |

## Human-In-The-Loop Integration

| Capability | `pi-subagents` | Tintinweb | Gotgenes | Stratum.pi |
| --- | --- | --- | --- | --- |
| Child-to-parent questions | Native supervisor channel | No | Permission companion only | Shared HITL service |
| Durable interaction queue | Partial file channel | No | No | External shared service |
| Permission `ask` forwarding | Direct-child integration | No | Permission companion | Shared permission and HITL services |
| Reconcile unresolved request on resume | No | No | No | Yes |
| UI owns pending request | Parent channel | N/A | Parent permission UI | No |

## Primary Sources

- Process-based control and revival:
  `references/pi-subagents/src/runs/background/` and
  `references/pi-subagents/src/runs/foreground/subagent-executor.ts`.
- Tintinweb steering, resume, retention, and worktrees:
  `references/tintinweb-pi-subagents/src/agent-manager.ts`,
  `src/agent-runner.ts`, `src/ui/conversation-viewer.ts`, and `src/worktree.ts`.
- Gotgenes typed service and lifecycle:
  `references/gotgenes-pi-packages/packages/pi-subagents/src/service/`,
  `src/lifecycle/`, and the companion `pi-subagents-worktrees` package.
