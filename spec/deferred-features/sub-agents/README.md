# Sub-Agents Specification

Status: **Draft**

This document specifies the required behavior of Stratum.pi's focused sub-agent
runtime.

See [reference-comparison.md](./reference-comparison.md) for the source-runtime
comparison behind these requirements.

## Goals

- Run foreground and background sub-agents as in-process Pi sessions.
- Persist every child conversation as a normal Pi JSONL session.
- Stop active execution when Pi exits while keeping agents resumable.
- Support manual and automatic restoration after reload, restart, or crash.
- Give foreground and background agents the same management capabilities.
- Support non-disruptive steering, deliberate interruption, and interruption
  with immediate follow-up.
- Provide extensive reusable agent definitions.
- Enforce exact tool and extension filtering before child execution.
- Validate effective models against Pi's scoped-model policy.
- Preserve isolated implementation work on durable Git branches.
- Recreate missing worktrees at their original paths.
- Expose the runtime to other extensions without requiring them to understand
  its internal implementation.
- Provide a rich optional UI without making UI state authoritative.

## Non-Goals

- The runtime does not own workflow graphs, fan-out/fan-in, pipelines, workflow
  budgets, or deterministic workflow replay.
- Sub-agents cannot launch sub-agents or Dynamic Workflows.
- The runtime does not decide `allow`, `ask`, or `deny` permission policy.
- The runtime does not own human-in-the-loop presentation or decision policy.
- Child execution does not remain alive after the owning Pi process exits.
- Delayed, one-shot, cron, and recurring execution are not supported.
- Stop, cancel, pause, and archive are not separate agent operations or states.
- Worktree branches are not automatically merged, pushed, or deleted.

## Core Concepts

A logical agent is the durable delegated worker shown to users and extensions.
Its identity remains stable for its entire retained lifetime.

An attempt is one period of model execution. Initial execution, resume, and an
interrupt with follow-up each create a new attempt.

A child session is the persisted Pi conversation. Continuing an agent preserves
that conversation while creating a new attempt.

Foreground and background are execution modes for an attempt, not permanent
properties of a logical agent.

## Identity And Persistence

The runtime must keep logical agent, attempt, child session, and parent session
identities distinct.

Continuing a completed, failed, interrupted, or disrupted agent must preserve
its logical agent identity and conversation. It must create a new attempt.

Every child conversation must use a persistent Pi JSONL session. In-memory-only
child conversations are not allowed.

The durable manager index stores metadata and trusted session/workspace paths.
It must not persist promises, abort controllers, Pi contexts, model objects,
extension contexts, UI components, or other process-local values.

Persisted data must be versioned, schema validated, and written atomically.

## Agent States

The runtime exposes these meaningful states:

| State | Meaning | Resume behavior |
| --- | --- | --- |
| Queued | Waiting for background capacity | Starts when admitted |
| Running | An attempt is executing | Concurrent resume rejected |
| Interrupting | A deliberate interrupt is settling | Wait for settlement |
| Interrupted | Deliberately suspended by an authorized user or extension | Explicit authorized resume only |
| Disrupted | Stopped by lifecycle or infrastructure conditions | Follows resume policy |
| Completed | Finished normally | May be explicitly continued when control authority permits |
| Failed | Attempt ended with an execution error | May be explicitly continued when control authority permits |

Every retained standalone logical agent is resumable. A retained
workflow-exclusive agent is resumable only through its owning workflow while it
remains current work. A superseded workflow-exclusive agent is retained as
non-resumable history. Deletion removes the durable record rather than merely
removing resumability.

Resume failure does not replace the agent's lifecycle state. For example, a
disrupted agent remains disrupted when its model is unavailable during resume.

## Attempt Lifecycle

Immediate creation starts an attempt in foreground or background mode.

Before execution, the runtime must:

1. Resolve the agent definition and invocation overrides.
2. Resolve and validate the effective model.
3. Resolve the exact extension set and tool allowlist.
4. Persist the logical agent, attempt, and child-session identities.
5. Wait for background admission when required.
6. Prepare the workspace when required.
7. Create the in-process Pi child session.
8. Register child identity and parent authority.
9. Bind filtered child extensions.
10. Start the prompt only after binding succeeds.

Failure while resolving the definition, initial model, extension set, or tool
allowlist rejects creation before a logical agent or attempt is persisted.

No child session or extension lifecycle is created while an attempt waits in the
background queue.

After persistence and admission, workspace preparation and child initialization
are part of the running attempt. A model becoming unavailable, workspace setup
failure, required-extension load failure, or extension binding failure settles
it as failed. A recoverable infrastructure failure settles it as disrupted and
remains subject to resume policy.

Every attempt owns a complete child extension lifecycle. A continuation uses the
same persisted conversation but creates a fresh in-process child session,
registers identity, binds current extensions, runs the prompt, emits child
shutdown exactly once, and disposes that session.

The runtime must persist attempt result, usage, and terminal state before parent
notification.

## Foreground And Background Execution

Foreground attempts bypass the background queue and are awaited by their caller.

Background attempts enter a configurable FIFO admission queue and return control
to their caller after durable creation.

Both modes support the same status, transcript, steering, interruption, and
continuation operations.

A manual continuation may choose foreground or background independently of the
prior attempt. Automatic resume preserves the disrupted attempt's mode:
background resumes in background and foreground resumes in foreground.

## Control Operations

The runtime exposes three distinct live control operations.

Every control operation authenticates the caller against the logical agent's
persisted control authority. Knowing an agent identifier is not authority.
Standalone agents permit the normal authorized user and extension surfaces.
Workflow-exclusive agents accept control only from their registered owning
workflow service. Direct user, UI, tool, command, and unrelated-extension
control requests must fail closed without changing agent state.

Every workflow-exclusive control or deletion request must also present proof of
the owner's current workflow-run claim. DurableAgent verifies that claim through
the registered authority before mutating the agent, then uses its own agent claim
to serialize the operation. Owner identity alone is insufficient. A stale owner,
expired claim, replaced extension generation, or mismatched run cannot steer,
interrupt, continue, resume, or delete the child.

### Steer

Steer accepts an agent and a non-empty message.

It is non-disruptive:

- The active model response and tool-call batch are allowed to finish.
- The message enters the conversation before the next model call.
- The same attempt continues.
- The current model and thinking configuration remain unchanged.

Steering works for foreground, background, initializing, and queued agents. A
steer sent before child-session creation remains durable and is delivered after
admission and initialization.

The runtime records when a steer is accepted, delivered, consumed, rejected, or
withdrawn. Acceptance alone must not be presented as proof that the model
consumed the message.

### Interrupt

Interrupt accepts an agent and no follow-up message.

It is a deliberate user or extension action:

- A queued attempt is removed from admission.
- A running response or tool is aborted.
- Partial result and interruption reason are persisted.
- The attempt settles as interrupted.
- Child shutdown and disposal complete normally.
- The logical agent remains interrupted until explicit resume.

A deliberate interrupt never automatically resumes, regardless of the agent's
normal resume policy.

Interrupting an active tool does not imply rollback. Partial filesystem or
external side effects may remain and must be surfaced.

### Interrupt With Follow-Up

Interrupt with follow-up accepts an agent, a non-empty message, an optional
model-and-thinking pair, and an optional foreground/background override.

It is one durable operation:

1. Validate requested model and thinking overrides.
2. Persist the follow-up before interrupting.
3. Abort and settle the current attempt as interrupted.
4. Create a new attempt in the same conversation.
5. Submit the follow-up as the first prompt of that attempt.
6. Link the durable control operation to the new attempt.

This operation is for queued or running agents. A settled agent uses Resume
instead.

If Pi exits between interruption and continuation, startup recovery must finish
the explicit follow-up independently of the agent's normal resume policy.

If continuation cannot start, the follow-up remains associated with the agent
and the resume error is recorded. Dependency repair retries this explicit
follow-up. A normal Resume must not create a competing continuation while it is
pending.

Calling Interrupt on an agent with a pending failed follow-up withdraws that
follow-up and leaves the agent interrupted for ordinary manual resume.

## Resume

Resume accepts a settled agent, a non-empty continuation message, an optional
model-and-thinking pair, and an optional foreground/background override.

Resume must:

1. Prove ownership of the logical agent.
2. Validate the persisted session and conversation identity.
3. Validate the effective model against current scoped models.
4. Reapply current permission policy.
5. Re-resolve required extensions and tools.
6. Reuse or restore the workspace.
7. Reconcile unresolved control and human-interaction requests.
8. Create and persist a new attempt.
9. Start a fresh child extension lifecycle over the existing conversation.

Concurrent resume of a running agent must be rejected.

## Resume Policies

Each agent has a manual or automatic resume policy.

### Manual Policy

After disruption, the agent remains disrupted until explicitly resumed through:

- A service or tool command.
- A UI Resume action.
- A context-menu or right-click Resume action.

### Automatic Policy

Automatic policy applies only to involuntary disruption, including:

- Pi shutdown.
- Extension reload.
- Parent-session replacement.
- Process crash.
- Recoverable infrastructure failure.
- Ownership lease loss.

Automatic policy never resumes a deliberately interrupted, completed, or failed
agent.

Automatic resume uses the same validation and restoration steps as manual
resume. It preserves the disrupted attempt's foreground or background mode.

## Resume Errors

A failed resume is an operation error, not an agent lifecycle state.

Examples include:

- Missing or invalid session transcript.
- Supplying a model without thinking, or thinking without a model.
- Unavailable or out-of-scope model.
- Missing required extension or tool.
- Unavailable permission authority.
- Missing worktree branch.
- Conflicting worktree path.
- Another Pi process owning the agent.

The failed operation must return a typed, actionable error while preserving the
agent's existing state.

The runtime also persists the latest resume failure as diagnostic metadata so:

- Automatic resume does not enter a tight retry loop.
- The UI can explain the failure after restart.
- Operators retain an audit trail.
- Retry can wait for a relevant dependency or configuration change.

The diagnostic records whether the failed operation was manual resume,
automatic resume, or interrupt with follow-up. It also records enough
configuration identity to determine whether a meaningful dependency changed.

When resume succeeds, the latest resume-failure diagnostic is cleared and a new
attempt becomes queued or running.

Automatic-policy disruption may retry after a relevant dependency changes.
Manual-policy disruption waits for explicit Resume. A failed interrupt with
follow-up retries because the follow-up itself was an explicit durable request,
unless the user withdraws it with Interrupt.

## Shutdown, Reload, And Crash Recovery

On graceful Pi shutdown or extension reload, the runtime must:

1. Stop admitting new background work.
2. Persist unresolved control requests.
3. Abort active child attempts for disruption.
4. After requesting abort, wait up to the configured shutdown grace period for
   the active model turn, tool call, session events, and persistence writes to
   settle. Continue cleanup when they settle or when the deadline expires.
5. Persist final session and attempt state.
6. Mark unfinished active attempts disrupted.
7. Emit child shutdown exactly once.
8. Unregister child identity.
9. Dispose child sessions and runtime resources.

Automatic-policy queued work remains queued for startup admission. Manual-policy
queued work becomes disrupted.

An attempt already settling a plain user interrupt becomes interrupted and must
not auto-resume. An attempt settling an interrupt with follow-up retains that
explicit continuation request for startup recovery.

On startup, stale running attempts must not be assumed active. The runtime must
reconcile persisted control intent first:

- A plain user interrupt settles as interrupted.
- An interrupt with follow-up continues its explicit durable operation.
- Other stale active attempts settle as disrupted.

Two Pi processes must never resume the same agent concurrently. Ownership must
use expiring, token-guarded claims and re-read durable state after acquisition.

## Agent Definitions

Definitions are Markdown files with YAML frontmatter. Project definitions
override user definitions with the same name. Names are case-insensitive but
retain display casing.

Definitions support:

- Name, display name, description, and enabled state.
- System prompt and append or replace prompt mode.
- Model and thinking as one required pair when either is explicit.
- Built-in tool allowlist.
- Extension allowlist.
- Per-extension tool allowlist.
- Tool denylist.
- Skills and context inheritance.
- Persistent memory scope.
- Maximum turns and grace turns.
- Background default.
- Resume policy.
- Worktree isolation.
- Permission-policy reference or per-agent policy block.
- UI presentation metadata.
- Explicitly locked fields.

Invocation values override definition defaults unless a definition explicitly
locks the field. Unknown fields are validation errors.

## Models And Thinking

The effective model-and-thinking pair is selected in this order:

1. Invocation pair.
2. Agent-definition pair.
3. Current parent pair.

An explicit selection must provide both model and thinking. Supplying only one
is invalid. Omitting both inherits the next complete pair in the selection
order. Agent definitions must follow the same rule.

The resolved model must be authenticated and allowed by the effective scoped
model policy. An explicit or definition model outside scope fails closed. The
runtime must not silently select another model.

Each attempt uses one effective model and thinking configuration. Steer never
changes them. Resume and Interrupt With Follow-Up may choose new values because
they create new attempts.

## Tool And Extension Filtering

Extension loading and model-facing tool exposure are separate decisions.

The runtime must construct the exact built-in and extension-tool allowlist
before child-session creation. It must fail clearly when a required extension or
requested tool cannot be resolved.

The runtime's own spawn, result, and control tools must be absent from child
sessions. Dynamic Workflow tools must also be absent.

No child can launch another child or workflow, including through inherited
extensions.

Extension filtering is not a complete security boundary. Current permission
policy applies independently to every child tool call.

## Worktrees

Worktree isolation uses a stable branch and deterministic path per logical
agent.

Agent setup resolves one effective boolean worktree-isolation choice from the
invocation and definition default. Disabled uses the supplied normal workspace.
Enabled requires a durable isolated worktree and branch and fails closed if they
cannot be established.

Running, queued, interrupted, disrupted, failed agents, and agents with a
recorded resume failure keep their worktree directories. Pi shutdown, reload,
restart, or crash must not intentionally delete unfinished worktrees.

Completed-turn changes must remain on the durable agent branch. Dirty work must
be preserved or captured as a recovery patch before destructive repair.

Completed worktree directories follow configurable retention. The durable agent
branch remains until explicit cleanup.

Before resuming a worktree agent, the runtime must:

1. Validate repository identity and the retained branch.
2. Reuse the existing worktree when its path, registration, branch, and revision
   are valid.
3. Recreate a missing worktree at the same path from the retained branch and
   latest durable checkpoint.
4. Apply a validated recovery patch when required.
5. Refuse recovery if the target path contains unrelated data.
6. Restore the child session with the worktree as its working directory.

Checkpoint commits are created at completed turn boundaries and graceful
shutdown. Dirty snapshots or recovery patches are captured after completed
mutating tool calls that have not yet been checkpointed.

DurableAgent exposes a runtime-authored workspace artifact independently of the
model's text result. For isolated agents it includes the repository identity,
durable branch, worktree path, base revision, latest checkpoint, and dirty or
recovery status when available. The branch identity remains usable after
configured worktree-directory cleanup until explicit branch cleanup.

An abrupt crash during a mutating tool can leave partial work only in the
retained directory. The runtime must preserve and surface it. If an external
actor deletes that directory before a snapshot exists, recovery can restore only
the latest durable checkpoint and must report possible loss.

## Retention And Deletion

Agent metadata, attempt history, and Pi JSONL transcripts are retained by
default. Read-only transcript projections and operational logs may use shorter
configurable retention.

Interrupted, disrupted, failed worktrees, and worktrees belonging to an agent
with a recorded resume failure are retained. Completed worktree directories may
be removed after a configured period, but their branches remain until explicit
cleanup.

Evicting an in-memory projection must not remove the durable record or
transcript. An uncached agent remains restorable through JSONL and resumable when
its persisted control authority and workflow relationship permit.

Logical-agent deletion is explicit and permanently removes or tombstones the
durable agent metadata. The caller separately chooses whether deletion also
removes the transcript, worktree directory, and branch. Workflow supersession
may instead make an exclusive agent non-resumable while retaining all history.

Deletion obeys persisted control authority. A workflow-exclusive agent can be
deleted only by its owning workflow service as part of an authorized workflow
operation. A user deletes or retains those children through the workflow run,
not through direct agent deletion.

Artifact cleanup while retaining the logical agent may remove logs, projections,
or completed worktree directories. It must not remove the conversation or branch
data required to resume that retained agent.

Deleting a running or queued agent first interrupts and settles its active
attempt, then removes or tombstones the durable record according to audit policy.

## Human-In-The-Loop Integration

The sub-agent runtime does not implement its own human queue or decision UI.

Child questions, permission prompts, and approvals route through Stratum.pi's
[shared human-in-the-loop service](../hitl/README.md). Interactions retain enough
ownership identity to reconcile the correct logical agent, attempt, child
session, and parent.

Restoration must reconcile unresolved interactions before continuing the child.
An answer must never be delivered to a different restored agent or attempt.

Before creating a continuation attempt, DurableAgent reconciles every interaction
owned by the prior attempt:

- A durably resolved answer is applied to the exact prior request and its
  resulting conversation or operation outcome is persisted before continuation.
- An unanswered request is cancelled atomically as belonging to the settled
  attempt.
- If cancellation loses a terminal-state race, DurableAgent re-reads the exact
  winning outcome. It applies a resolved result to the prior attempt. It persists
  and interprets rejection, prior cancellation, or expiry under the producer's
  defined failure behavior before continuing.
- A successfully cancelled request is recorded in the continuation context, and
  the child may issue a new request with a new identity from the new attempt.
- A late answer to a cancelled prior-attempt request is rejected.
- If exact request, attempt, conversation, and outcome identity cannot be proven,
  continuation fails closed with a recoverable diagnostic.

Continuation starts only after an idempotent reconciliation barrier proves every
prior-attempt request terminal and persists the effect or producer-defined
interpretation of every terminal outcome. A crash while applying an answer or
terminal failure repeats reconciliation rather than starting the next attempt
early.

An answer is never transferred or silently reissued under a new attempt
identity.

Permission policy remains responsible for `allow`, `ask`, and `deny`. The
interaction service transports and resolves human decisions.

## Extension Integration

Other extensions can create, inspect, and wait for agents through a versioned
service. Resume, steer, interrupt, and delete operations are available only when
the caller satisfies the target agent's persisted authority.

An owning extension may be registered as the recovery authority for agents it
creates. For those agents, DurableAgent preserves and exposes disruption state
but does not independently apply automatic resume. The owning extension claims
the agent and invokes normal DurableAgent recovery after reconciling its own
durable state. This prevents competing automatic-resume decisions.

An owning extension may also create an agent with exclusive control authority.
That immutable mode persists for the retained lifetime of the logical agent and
cannot be detached or converted to standalone control. DurableAgent still
supports read-only inspection and normal human-interaction responses, but only
the owner may invoke lifecycle and conversation controls or deletion. If the
owner is unavailable, the agent remains retained and inaccessible to competing
controllers rather than falling back to user control.

Exclusive authority registration includes a durable workflow-run identity and a
claim-verification mechanism. Every mutating request is checked against current
run ownership at use time; registration is not a permanent bearer capability.

The service must expose the three live control operations exactly as described:

- Steer with an agent and message.
- Interrupt with an agent.
- Interrupt With Follow-Up with an agent, message, and optional continuation
  overrides.

Same-process consumers resolve the current service generation per use rather
than caching it across reload. Registrations and subscriptions provide safe
disposal so an old extension generation cannot remove a newer one.

Runtime events are notifications, not the durable source of truth. Consumers
can observe agent creation, queue admission, attempt start and settlement,
interruption, disruption, control delivery, workspace changes, resume failures,
and deletion.

## UI Requirements

The UI is a projection over the runtime and durable store. Closing or replacing
the UI must not interrupt or invalidate an agent.

The UI supports:

- A unified foreground and background fleet.
- Queued, running, interrupting, interrupted, disrupted, completed, and failed
  views.
- Current tool, activity, turn, token, context, model, thinking, duration, and
  workspace status.
- Full live and historical transcript viewing.
- Search over retained agents and transcripts.
- A chat composer backed by durable steering.
- Separate Steer, Interrupt, and Interrupt With Follow-Up actions.
- Resume through command, button, and context-menu/right-click action.
- Automatic-resume policy controls.
- Model, thinking, and execution-mode selection for continuation.
- Worktree branch, path, dirty state, checkpoint, recovery, and merge guidance.
- Clear resume-error diagnostics and repair actions.
- Optional compact widgets and a full management overlay.

Direct control UI is hidden or disabled for workflow-exclusive agents. Their
read-only transcript, status, usage, and workspace artifacts remain available
through the owning workflow projection, which links users to workflow editing,
interruption, recovery, and deletion controls instead.

Portable dialogs should work in TUI and RPC modes. Terminal components, raw
input, themes, and custom editors are TUI-only.

## Workflow Integration

The sub-agent runtime resumes agents, not workflow graphs.

Workflow runtimes remain responsible for call indexes, semantic hashes,
dependency graphs, fan-out/fan-in, replay order, workflow retries, and aggregate
results.

The sub-agent runtime exposes enough stable result and attempt history for a
workflow runtime to reuse a completed result or request a continuation.

Workflow children use exclusive control authority. Workflow editing and
workflow-level controls are the only user-facing way to change or continue their
work. Superseded or retained children remain inspectable but cannot be resumed as
standalone agents.

## Failure And Security Behavior

The runtime fails closed when ownership, parent authority, current permission
policy, model scope, required extensions/tools, persisted paths, or requested
workspace isolation cannot be proven.

Optional UI unavailability is not a runtime failure.

Shutdown errors are recorded but do not prevent remaining cleanup steps.

Session and workspace paths are constrained to trusted roots. Path traversal,
unsafe symlinks, and unrelated occupied worktree paths are rejected.

Worktrees provide file isolation, not process or security isolation.

Persisted authorization decisions never replace current permission policy.

## Required Test Areas

- Foreground and background lifecycle equivalence.
- Exact extension and tool filtering.
- Child identity registration before extension binding.
- Exactly-once child shutdown.
- Manual and automatic resume after reload, restart, and simulated crash.
- Automatic resume preserving the disrupted attempt's execution mode.
- Fresh attempt sessions over persisted conversations.
- Stable logical identity and new attempt identity on continuation.
- Steering before session creation and during tool execution.
- Deliberate interruption never automatically resuming.
- Disruption following manual and automatic policy.
- Interrupt With Follow-Up recovery at every persistence boundary.
- Resume failure preserving lifecycle state and diagnostic history.
- Scoped-model enforcement at spawn and resume.
- Rejection of every model-only or thinking-only explicit selection.
- Permission-policy reapplication after restoration.
- Concurrent resume claim rejection.
- Worktree reuse, recreation, dirty recovery, path conflict, and missing branch.
- Runtime-authored workspace artifacts retain durable branch identity.
- Retention and deletion boundaries.
- Workflow-exclusive agents reject every direct control and deletion surface.
- Workflow-exclusive mutations require a valid current workflow-run claim.
- Exclusive authority survives reload, restart, owner absence, and supersession.
- Prior-attempt interactions resolve or cancel before continuation and never
  transfer to a new attempt identity.
- UI absence, RPC fallback, and TUI-only capability guards.
- Reconciliation of unresolved human interactions.
- Cancellation losing a terminal-state race persists and interprets the winning
  outcome before continuation.

## Open Decisions

- Exact persistence root and project identity derivation.
- Claim duration and heartbeat cadence.
- Checkpoint commit naming and whether checkpoints are squashed before handoff.
- Default completed-worktree retention duration.
- Agent-definition versioning and locked-field syntax.
- Transcript indexing strategy for UI search.
