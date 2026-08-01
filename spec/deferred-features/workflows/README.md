# Workflow Engine Specification

Status: **Draft**

This document specifies the required behavior of Stratum.pi's workflow engine.

The workflow engine runs model work through the durable sub-agent runtime defined
in [the sub-agent specification](../sub-agents/README.md). It owns workflow
programs, call identity, orchestration, replay, budgets, verification, and
workflow-level recovery. DurableAgent owns child conversations, attempts,
steering, interruption, permissions, transcripts, and workspaces.

## Goals

- Execute trusted JavaScript workflow files in a restricted `node:vm` context.
- Inspect a workflow before execution to discover available metadata and a graph
  preview.
- Support sequential work, parallel work, dynamic fan-out/fan-in, branches,
  loops, pipelines, phases, and reusable workflows.
- Run every engine-managed workflow model call through DurableAgent.
- Persist workflow source, revisions, calls, results, graph materialization, and
  operational history.
- Replay unchanged completed calls without restarting their agents.
- Continue unchanged disrupted calls through their existing durable sub-agent
  conversations.
- Allow workflow source to be edited before recovery.
- Resume edited workflows using conservative deterministic replay.
- Support manual and automatic recovery after reload, restart, or crash.
- Support structured outputs, validation, retries, verification, judging, and
  completeness patterns.
- Enforce workflow, phase, concurrency, time, token, and cost limits.
- Route human checkpoints through the shared human-in-the-loop service.
- Preserve parallel implementation work through DurableAgent worktrees.
- Provide rich UI and machine-readable observability without making UI state
  authoritative.

## Non-Goals

- The workflow engine does not implement a second child-agent runtime.
- Workflow children cannot launch sub-agents or workflows themselves.
- The workflow engine does not own permission policy.
- The workflow engine does not own human-interaction queueing or presentation.
- The restricted VM is not a security boundary for hostile code.
- Metadata inspection is not guaranteed to discover every runtime path in
  arbitrary JavaScript.
- The initial specification does not define the complete workflow helper API,
  metadata format, or graph representation.

## Core Concepts

A workflow definition is a trusted JavaScript file evaluated with only the
engine-approved workflow capabilities and in-realm ECMAScript built-ins.

A workflow run is one durable logical execution of a workflow definition.

A workflow revision is an immutable execution bundle used for an initial
execution or later recovery. It contains the exact root source, the transitively
referenced reusable workflow definitions, and a manifest of behavior-affecting
VM, engine capability, and configuration versions. Inspection and execution bind
atomically to that same bundle. Editing a disrupted workflow creates a new
revision without overwriting earlier source or dependencies.

If the current runtime cannot provide a behavior-compatible pinned capability or
dependency, recovery fails closed with a persisted operation diagnostic. It does
not silently run the old revision against new semantics. A user may explicitly
create and inspect a replacement revision under the new runtime. Encountered
call behavior remains the final compatibility check and divergence ends replay.

A workflow execution attempt is one period in which the engine evaluates a
revision. Reload, restart, crash, deliberate interruption, or edited recovery may
end one attempt and lead to another.

A workflow call is one durable orchestration operation encountered while the
program runs. A model call links to one logical DurableAgent child.

The inspected graph is a preview or graph template. The materialized graph is
the authoritative set of calls and dependencies reached during actual
execution.

## Execution Model

Workflow execution has two phases:

| Phase | Purpose | External effects |
| --- | --- | --- |
| Metadata inspection | Discover metadata, requirements, calls, dependencies, phases, and graph templates | Workflow operations are dummy recording operations |
| Execution | Replay or perform real workflow operations | DurableAgent, HITL, persistence, and workspace operations are active |

Metadata inspection of the exact pinned revision must complete successfully
before every execution attempt. Automatic recovery reinspects the unchanged
bundle before re-evaluation. If that inspection fails, the attempt performs no
execution work, records a recoverable operation diagnostic, and leaves the
workflow's factual lifecycle state unchanged. Persisted prior inspection remains
available for history and UI but does not authorize execution after a failed
reinspection.

## Phase One: Metadata Inspection

The engine evaluates the workflow using dummy recording implementations of its
custom workflow operations.

Engine-provided dummy workflow operations must not:

- Start or resume sub-agents.
- Submit human-interaction requests.
- Create or mutate workflow workspaces.
- Consume workflow budgets.
- Advance durable workflow execution, consume budgets, or write call results.

The engine may persist the workflow revision, inspection output, and validation
diagnostics. These are inspection artifacts, not execution progress.

At the start of the first inspection attempt for a logical workflow run, the
engine chooses and persists a run clock value and a run random value before
evaluating workflow source. Failed inspection, reinspection, execution,
interruption, disruption, and edited recovery retain those same values. They do
not change between revisions or attempts of the same run.

Inspection should discover as much of the following as the workflow exposes:

- Workflow name and descriptive metadata.
- Declared phases.
- Calls and call labels.
- Static dependency edges.
- Parallel groups and pipelines.
- Branch paths and merge points.
- Dynamic fan-out and loop templates.
- Agent definitions and model requirements.
- Tool and extension requirements.
- Structured-output and validation requirements.
- Workspace requirements.
- Human checkpoints.
- Budget and concurrency declarations.

The resulting graph is a preview. It must identify which parts are static and
which are representative dynamic templates.

### Inspection Validation

Inspection validates every concrete declaration it discovers before execution.
This includes:

- Complete model-and-thinking pairs and valid inheritance.
- Current model authentication and scoped-model availability.
- Agent-definition identity and enabled state.
- Required extensions and exact tool allowlists.
- Structured-output schemas and statically known quality policies.
- Budget, concurrency, retry, checkpoint, and workspace-option values.
- Duplicate or ambiguous explicit call identities.
- Reusable workflow references and pinned dependency identity.

Invalid concrete declarations make inspection fail before any agent, checkpoint,
workspace, or budget operation begins. Values that genuinely depend on runtime
results are validated when they materialize during execution. Execution still
revalidates current model scope, permissions, tools, extensions, and workspace
requirements because availability or policy may change after inspection.

### Branches

Workflow branches should be expressed through workflow control-flow operations
when complete inspection is required.

During inspection, both paths of an explicit workflow branch are evaluated with
dummy operations so
the graph can show both possibilities and their merge point.

During initial execution, the condition is evaluated once and only the selected
path is executed. The selected path is journaled. Recovery of an unchanged
compatible branch replays that journaled selection rather than evaluating a
possibly input- or prior-result-dependent condition again. An edited or
invalidated branch evaluates its current condition as new live work.

The exact branch helper and condition representation are deferred.

### Loops And Dynamic Fan-Out

When loop input is already concrete during inspection, the inspector may observe
its concrete structure.

When explicit loop or fan-out input depends on runtime results, inspection uses
one or two representative symbolic values to discover the worker shape. Two
values are used when first-item and subsequent-item behavior may differ. Failure
to inspect a required representative body makes the workflow revision invalid.

Representative values do not imply that execution will have one or two items.
The inspected graph must show a dynamic template with runtime cardinality.

Actual execution materializes the workflow operations reached by each real item.
Stable item keys are preferred over indexes for identity and audit. Under the
initial longest-prefix replay rule, insertion or reordering still ends prefix
reuse even when later item keys remain stable.

Control flow that must be completely inspectable should use explicit workflow
branch, selection, fan-out, or loop operations. Native JavaScript control flow
remains allowed but receives best-effort inspection and replay guarantees.

### Restricted Inspection Context

Metadata inspection evaluates the workflow in a fresh restricted `node:vm`
context. It exposes the same named workflow capabilities as execution, but with
dummy recording implementations.

The context must not provide a module loader or ambient Node capabilities.
Static imports, dynamic `import()`, and `require()` are rejected. `process`,
`module`, `exports`, `Buffer`, `fetch`, filesystem, network, subprocess, worker,
and other Node or host APIs are unavailable unless a later specification adds an
explicit workflow capability for them.

Workflow source validation should report prohibited syntax and capability access
with source locations before evaluation. Runtime restriction remains
authoritative when validation cannot determine access statically.

The VM context disables string and WebAssembly code generation. Calls to
`eval`, `Function`, related string-based constructors, and WebAssembly compilation
must fail. Host built-ins and live host objects must not be injected merely for
convenience; workflow inputs cross the boundary as plain data.

Normal deterministic in-realm ECMAScript built-ins remain available. Ambient
clock and randomness APIs are replaced with immutable run-scoped values:

- `Date.now()` returns the persisted run clock.
- `Date()` returns the string representation of the persisted run clock.
- `new Date()` without arguments represents the persisted run clock.
- `Math.random()` always returns the persisted run random value.
- Explicit date parsing and construction from arguments retain normal
  deterministic behavior.

Inspection and every execution or recovery attempt observe the same values. The
engine prevents workflow code from replacing these implementations. Workflows
that need changing time or multiple random values receive them through explicit
persisted input or durable workflow operations with normal stable identity,
result persistence, and replay behavior.

The runtime clearly identifies metadata inspection mode through an approved
workflow capability. Inspection-mode code still cannot acquire additional host
authority.

## Phase Two: Execution

Execution evaluates the selected workflow revision with real workflow
operations.

For each encountered call, the engine must:

1. Determine stable call identity and behavior identity.
2. Compare the call with compatible journal history.
3. Replay, continue, or execute according to the call's durable state.
4. Persist the call result before returning it to workflow JavaScript.
5. Materialize actual graph nodes and dependency edges.
6. Update usage, budgets, progress, and observable events.

The materialized execution graph is authoritative when it differs from the
inspection preview.

## Durable Sub-Agent Calls

Every model call expressed through engine-provided workflow operations is
performed through DurableAgent. The restricted context does not expose provider
libraries, provider credentials, arbitrary network access, or another model-call
path.

The workflow engine persists the relationship between the workflow call and its
logical child agent. It remains responsible for deciding whether that child's
result should replay, its conversation should continue, or a new child should be
created.

Each workflow-owned child delegates automatic-recovery authority to the workflow
engine. DurableAgent records disruption and provides recovery mechanics but does
not independently auto-resume that child.

Workflow-owned children use exclusive workflow control authority. Users and
unrelated extensions may inspect their status, transcript, usage, results, and
workspace artifacts, but cannot directly steer, interrupt, continue, resume, or
delete them. Those operations are accepted only from the owning workflow engine
while it holds the workflow run claim. A user changes child behavior by editing,
interrupting, recovering, or deleting the workflow run rather than operating on
the child directly.

The engine supplies verifiable current workflow-run claim proof with every child
control or deletion request. DurableAgent rejects stale owner generations and
requests made after claim loss before changing child state.

| Durable call condition | Workflow behavior |
| --- | --- |
| Completed and unchanged | Replay the persisted result without opening a child session |
| Child completed but workflow journal is missing completion | Adopt the DurableAgent result as historical completion; replay only when the current call remains compatible |
| Running with a dead owner | Reconcile as disrupted before deciding recovery |
| Disrupted and unchanged | Resume the existing logical child and conversation when workflow recovery permits |
| Deliberately interrupted | Do not resume until explicit workflow recovery authorizes the engine |
| Failed | Apply the workflow's retry or failure policy |
| Missing or invalid child conversation | Return a resume error while keeping workflow recovery possible |
| Changed behavior identity | Do not replay; create replacement live work |
| Removed from edited workflow | Retain history but do not execute or replay it |

Completed calls must not restart merely because the workflow engine restarted.

Disrupted calls continue through the normal DurableAgent Resume behavior. They
preserve logical child identity and conversation while creating a new child
attempt.

Before every same-child continuation, the workflow engine persists a non-empty
continuation instruction and its reason. This applies to disruption recovery,
explicit recovery of a workflow-interrupted child, and retry with feedback. The
engine supplies that instruction when invoking DurableAgent Resume and journals
the resulting attempt. Default recovery instructions are versioned with call
recovery behavior and participate in compatibility decisions; attempt-specific
retry feedback is journaled as a retry decision.

The workflow engine is the sole automatic-resume authority for workflow-owned
children. DurableAgent performs the recovery under delegated authority but does
not independently race the workflow engine to resume the same child.

## Call Identity And Replay

Each call needs stable position or explicit identity plus a semantic identity of
its behavior.

Behavior identity must account for values that can change the meaning of a call,
including:

- Prompt or input.
- Agent definition.
- Model and thinking pair.
- Tool and extension selection.
- Structured-output schema.
- Workspace policy.
- Relevant retry and verification behavior.

Presentation-only changes should not invalidate completed results.

Replay returns the persisted result as if the operation had completed during the
current evaluation. It must not reopen the child, repeat model usage, or repeat
the child's side effects.

The workflow must also restore any journaled workflow state needed after the
call, rather than relying on process-local values from the old attempt.

## Conservative Replay

The default safety rule is longest unchanged prefix replay.

The engine replays compatible calls in encounter order. At the first changed,
missing, inserted, reordered, or invalid call, automatic prefix replay stops and
the remaining workflow executes live.

Encounter order is assigned when a workflow operation is invoked or registered,
never when its asynchronous work is admitted or completed. Parallel helpers
assign deterministic child scopes in declared input order before starting work.
Nested reusable workflows receive stable namespaced call scopes beneath their
parent invocation. Dynamic items use their deterministic source order and stable
item keys. A construct whose call order or namespace cannot be reproduced fails
validation rather than producing an ambiguous replay prefix.

This rule prevents an apparently unchanged downstream call from reusing a result
whose upstream assumptions changed.

More granular dependency-aware invalidation may be added later for explicitly
declared graphs, but it is not required initially.

## Editable Recovery

A disrupted or interrupted workflow may be edited before recovery.

Editing creates a new workflow revision. Earlier revisions, calls, results, and
children remain available for audit.

Before execution of an edited revision, the engine must:

1. Persist the proposed revision without replacing the prior revision.
2. Run metadata inspection on the proposed revision.
3. Reject invalid workflow source without changing the active durable run.
4. Compare encountered calls with prior journal history.
5. Explain which prior calls are reusable, invalidated, added, or removed when
   that information is available.

During edited recovery:

- Unchanged completed calls replay.
- An unchanged non-terminal checkpoint inside the compatible prefix retains its
  exact HITL request and continues waiting without asking again.
- An unchanged disrupted call continues its existing DurableAgent child only
  while it remains inside the compatible replay prefix.
- A changed call creates replacement live work.
- A removed call remains historical.
- A newly selected branch executes live.
- The first incompatible call ends longest-prefix replay.

Before replacement suffix work begins, the engine reconciles every non-terminal
checkpoint invalidated by changed, removed, reordered, or out-of-prefix behavior.
It cancels a pending or claimed HITL request under workflow authority, which also
invalidates and dismisses active provider presentation. If cancellation loses a
race to resolution, the engine persists that answer as historical and uses it
only when current checkpoint compatibility and prefix rules permit. Otherwise
the obsolete answer cannot affect current control flow. This reconciliation is
idempotent across another crash.

After the first incompatibility, downstream completed results do not replay and
downstream disrupted conversations do not automatically continue, even when
their local call inputs appear unchanged. They may depend on invalidated upstream
assumptions.

Children belonging to changed, removed, or invalidated calls are marked
superseded in the workflow relationship. Their conversations, attempts,
worktrees, and branches remain retained, but workflow recovery no longer treats
them as current work.

Before supersession becomes effective, the workflow engine interrupts and
settles any active attempt under its current claim and cancels unanswered child
interactions that belong to the settled attempt. Resolved interactions and their
outcomes remain historical. Supersession then disables recovery and leaves the
child as workflow-exclusive, read-only retained history. It cannot be continued
as standalone work. New work based on a superseded child must be represented by
an edited workflow call or another explicit workflow operation.

The workflow run keeps one stable logical identity while recording every source
revision and execution attempt used to continue it.

## Crash Windows And Reconciliation

The engine must handle a child completing immediately before workflow
persistence.

If DurableAgent has a completed result but the workflow journal does not, the
engine verifies the call-to-child relationship, adopts the persisted child
result, and writes the missing historical workflow completion. It replays that
result into the current evaluation only when call behavior and compatible-prefix
rules permit. Otherwise the completed child remains historical and replacement
live work executes without rerunning the old child.

If the workflow journal says a call was running but DurableAgent reports a
different durable state, DurableAgent's attempt history is authoritative about
child execution while the workflow journal remains authoritative about graph
progression and replay decisions.

Reconciliation must be idempotent and safe to repeat after another crash.

The same crash-window rule applies when HITL resolves a checkpoint before the
workflow journals its answer. The engine adopts the exact durable result as
historical completion and replays it only when the current checkpoint remains
compatible. An incompatible or removed checkpoint retains the answer for audit
without applying it to current workflow control flow.

## Workflow Lifecycle And Recovery

The workflow engine distinguishes deliberate interruption from involuntary
disruption.

Deliberate interruption never automatically resumes. It requires explicit user
recovery.

Deliberately interrupting a workflow:

- Stops admission of new workflow calls.
- Invokes DurableAgent Interrupt for queued and running workflow-owned children.
- Persists the workflow's current graph and journal position.
- Leaves completed call results replayable.
- Leaves unanswered human checkpoints durable and answerable, but an answer does
  not resume workflow execution by itself.

Explicit workflow recovery authorizes the engine to resume the workflow and the
workflow-owned interrupted children still required by the compatible path. It
does not resume superseded or removed children.

Disruption includes Pi shutdown, extension reload, parent-session replacement,
process crash, recoverable infrastructure failure, or ownership loss.

Each workflow run has manual or automatic recovery behavior for disruption.

Automatic workflow recovery must:

1. Claim the workflow run so two Pi processes cannot recover it concurrently.
2. Load the selected workflow revision and journal.
3. Reconcile workflow-owned DurableAgent children.
4. Run metadata inspection.
5. Re-evaluate the workflow from the beginning.
6. Replay unchanged completed calls.
7. Continue unchanged disrupted calls that remain inside the compatible prefix.
8. Execute remaining live work under current budgets and concurrency limits.

Recovery failure is an operation error and diagnostic, not a replacement for the
workflow's factual lifecycle state.

## Workflow Source And Trust

Workflow JavaScript is trusted application code executed in a restricted
`node:vm` context. Node explicitly does not define `node:vm` as a security
mechanism, so Stratum.pi must not present this as safe execution of adversarial or
multi-tenant code.

The restriction is a capability boundary for normal trusted workflow code. A
fresh context is created for each inspection or execution attempt and receives
only approved workflow operations, plain workflow inputs, and deliberately
selected logging or inspection facilities. The inspection and execution
contexts have the same authority surface; only the implementations of workflow
operations differ.

Workflow files cannot import packages or local modules. Reusable helpers may be
declared in the same file. Reusable workflows or future shared helpers must be
resolved by an engine-controlled capability or registry whose identity
participates in revision compatibility.

The engine does not expose environment variables, Node APIs, filesystem state,
network access, subprocesses, workers, provider clients, or credentials directly
to workflow code. Any future external effect must be introduced as an explicit
least-authority workflow operation with defined inspection, persistence, replay,
budget, permission, and observability behavior.

Consequently, workflow JavaScript has no direct filesystem-access,
network-request, or subprocess-execution path and cannot create untracked host
side effects. External effects occur only through approved workflow operations.
DurableAgent children may still receive filesystem or other tools according to
their own definitions and current permission policy; that authority is not
exposed to the workflow VM itself.

The engine should harden injected bridge functions and values to avoid exposing
unnecessary host objects or authority. This hardening improves accidental misuse
resistance but does not upgrade `node:vm` into a hostile-code security boundary.
Running hostile workflow code would require separate process or container
isolation with operating-system enforcement.

The runtime must not claim deterministic replay after observed calls diverge. It
must stop replay at the first incompatibility, retain prior history, and execute
the changed suffix live.

## Concurrency And Limits

The engine supports bounded sequential and parallel execution.

Concurrency limits apply across all live workflow child calls, including dynamic
fan-out and nested reusable workflows.

The engine must support limits at appropriate scopes, including:

- Maximum concurrent child calls.
- Maximum total child calls.
- Workflow and phase token budgets.
- Cost budgets where provider pricing is available.
- Workflow deadlines and per-call time limits.
- Loop and fan-out limits.

Usage comes from DurableAgent attempt history rather than workflow-side
estimation.

Budget and limit decisions must be persisted so recovery does not forget prior
consumption.

The exact configuration surface and enforcement helpers are deferred.

## Structured Results And Quality

Workflow child calls may require structured results.

The engine supports behavior for:

- Schema validation.
- Bounded repair after invalid output.
- Retry with validation feedback.
- Independent verification.
- Judge or panel decisions.
- Best-of-N selection.
- Completeness checks.
- Per-item failure isolation.
- Fail-fast or collect-all parallel work.

Validation results, repair attempts, retry decisions, evidence, and verdicts
must be durable and visible during recovery.

The exact quality-helper API is deferred.

## Retry Behavior

Retry is separate from replay and resume.

For a failed call, workflow policy may choose to:

- Continue the existing logical child's conversation, which creates a new
  DurableAgent attempt.
- Create a new logical child with fresh context.
- Use a different valid model-and-thinking pair.
- Skip the call and preserve the failure.
- Fail the workflow.

Successful sibling results must remain available when collect-all behavior is
selected.

Every retry decision and resulting child relationship must be journaled.

## Human Checkpoints

Workflow checkpoints route through Stratum.pi's
[shared human-in-the-loop service](../hitl/README.md).

The workflow engine owns:

- Checkpoint identity within the workflow.
- Behavior identity and replay compatibility.
- Workflow timeout, default, and failure behavior.
- The meaning of the answer to workflow control flow.
- Journaling the resolved answer.

The shared interaction service owns:

- Durable request queueing.
- UI-provider routing.
- Claims between competing UIs.
- Answer persistence and delivery.
- Interaction cancellation and expiry.

An unanswered checkpoint must survive UI replacement, reload, restart, and
workflow-owner replacement.

An unchanged resolved checkpoint replays its persisted answer without presenting
the question again.

Checkpoint submission uses a durable idempotency key derived from stable workflow
run and checkpoint identity. Recovery must reconcile that request rather than
create a duplicate.

## Workspaces And Code Changes

The workflow engine has no policy about which calls should share the project
workspace or use a worktree. Each model call supplies a simple workspace-isolation
choice as part of its DurableAgent setup. The exact option name is deferred; its
behavior is boolean:

- Disabled uses the normal project workspace.
- Enabled requires DurableAgent to create or restore its durable isolated
  worktree and branch.

The engine passes this choice through without inferring it from parallelism,
read/write intent, or agent role. It does not reject parallel shared-workspace
writers or silently enable isolation. Workflow authors and agent setup are
responsible for choosing isolation appropriate to their work.

DurableAgent exclusively owns worktree creation, recovery, checkpointing,
retention, and cleanup. Requested isolation fails closed if DurableAgent cannot
establish it. The workflow engine records only the call option and the durable
workspace artifact returned by DurableAgent.

For an isolated call, that artifact identifies at least the repository, durable
branch, worktree path, base revision, latest checkpoint, and dirty or recovery
status when available. The artifact is journaled independently of model-authored
text and remains available after interruption, disruption, completion, replay,
or worktree-directory cleanup while its retained branch exists.

Later workflow calls may receive prior workspace artifacts and instruct their
agents to inspect, compare, merge, cherry-pick, synthesize, or otherwise use the
reported branches. The workflow engine does not perform those operations or
automatically merge successful branches.

## Models And Thinking

Workflow calls inherit DurableAgent model policy.

An explicit model selection must include thinking, and an explicit thinking
selection must include model. Omitting both inherits the next complete pair from
agent definition or parent context.

Every effective model must be authenticated and allowed by current scoped-model
policy.

Replaying a completed call uses its persisted result and incurs no new model
selection. Continuing or replacing live work validates the current effective
model-and-thinking pair before starting a new child attempt.

The journal retains the effective resolved pair used by every child attempt. The
call's initial pair remains part of revision compatibility. A policy-authorized
retry may select another complete pair; that override and the new attempt are
journaled without rewriting the original attempt. During revision recovery, a
newly resolved inherited initial pair is compared with the pair originally
resolved for that call. A change makes the call behavior incompatible rather
than silently continuing under a different model or thinking level.

The workflow may provide model tiers or role-based routing, but each resolved
call still produces one explicit valid pair. The exact routing configuration is
deferred.

## Tool, Extension, And Permission Policy

Workflow calls resolve exact DurableAgent definitions, extension sets, and tool
allowlists before execution.

Workflow and sub-agent orchestration tools must not be exposed inside workflow
children.

Current permission policy applies independently to every child attempt and is
reapplied on restoration.

Persisted authorization decisions do not replace current policy.

The workflow fails closed when required identity, authority, model scope,
extensions, tools, permissions, or workspace isolation cannot be established.

## Observability And UI

UI is a projection over durable workflow state. Closing or replacing it must not
invalidate a run.

The UI should expose:

- Workflow source and revision history.
- Inspection preview and materialized graph.
- Static, dynamic-template, materialized, replayed, invalidated, running,
  interrupted, disrupted, completed, and failed nodes.
- Phases, parallel groups, branches, loops, and fan-out cardinality.
- Linked DurableAgent child status and transcript.
- Model, thinking, token, cost, duration, and budget information.
- Human-input requirements.
- Worktree branch and recovery status.
- Replay and invalidation decisions after editing.
- Manual recovery and source-editing controls.
- Actionable recovery errors.

Workflow events are durable observations, not process-local truth. Consumers
must be able to reconstruct current state after missing events or restarting.

## Retention And Deletion

Workflow source revisions, journal entries, call relationships, results, and
attempt history are retained by default.

Deleting a workflow run is explicit. The user chooses whether linked child
agents, transcripts, worktrees, and branches are retained or deleted.

Deletion first claims the run, stops new work, interrupts and settles active
children, and cancels unanswered workflow checkpoints and child interactions.
Resolved answers and outcomes remain in retained audit history. Only after that
settlement may the engine delete children or mark retained children as
non-resumable workflow-exclusive history.

Deleting a workflow must never silently destroy child implementation work.
Retained children remain workflow-exclusive read-only history and cannot be
continued outside a workflow.

## Required Test Areas

- Inspection and execution each use a fresh restricted `node:vm` context.
- Static imports, dynamic imports, and `require()` are rejected.
- Ambient Node globals, provider clients, credentials, and host APIs are
  unavailable.
- String-based and WebAssembly code generation are disabled.
- Workflow inputs cross the VM boundary as plain data rather than live host
  objects.
- Inspection and execution expose the same capability names with dummy and real
  implementations respectively.
- Phase one persists one run clock and one run random value; inspection,
  execution, editing, and recovery observe those same immutable values.
- Concrete model-and-thinking pairs, agent definitions, tools, extensions,
  schemas, limits, identities, and workspace options are validated during
  inspection and revalidated when required before live work.
- A revision pins its complete reusable-workflow dependency closure and
  behavior-affecting VM and capability versions.
- Runtime or capability drift never silently changes an existing revision.
- Failed recovery reinspection performs no execution work and preserves factual
  lifecycle state.
- Metadata inspection performs no real workflow operations.
- Both paths of explicit branches appear in inspection.
- Dynamic loops produce representative templates and materialize real calls.
- Actual execution graph may safely differ from inspection preview.
- Every engine-managed workflow model call executes through DurableAgent.
- Workflow-owned children reject direct user and unrelated-extension control or
  deletion while remaining read-only inspectable.
- Every workflow-owned child mutation verifies the current workflow-run claim.
- Workflow-owned children delegate automatic-recovery authority without racing
  independent DurableAgent auto-resume.
- Completed unchanged calls replay without opening child sessions.
- Disrupted unchanged calls continue existing child conversations.
- Disrupted children receive their persisted workflow continuation instruction.
- Deliberately interrupted calls do not automatically resume.
- Workflow interruption propagates to active children while retaining completed
  results and pending checkpoints.
- Child completion is adopted after a crash before workflow journaling.
- Crash-adopted completion replays only when current compatibility permits.
- Edited recovery preserves prior revisions and history.
- Longest unchanged prefix replay stops at the first incompatibility.
- Parallel and nested calls receive deterministic encounter order and namespaced
  identity independent of admission or completion timing.
- Downstream disrupted children do not continue after prefix incompatibility.
- Changed, inserted, removed, and reordered calls reconcile safely.
- Superseded children remain non-resumable workflow-exclusive history.
- Supersession and workflow deletion settle active children and cancel unanswered
  interactions before making retained history read-only.
- Compatible branch selection replays without re-evaluating its condition.
- Invalid edited source does not mutate the active run.
- Workflow and child ownership claims prevent duplicate recovery.
- Budget consumption survives recovery.
- Retry, replay, resume, and replacement remain distinct.
- Resolved checkpoints replay without asking again.
- Unanswered checkpoints survive owner and UI replacement.
- Edited recovery retains compatible non-terminal checkpoints and cancels
  invalidated pending or claimed ones without losing a concurrently resolved
  answer.
- Checkpoint resolution before workflow journaling is adopted subject to current
  replay compatibility.
- Each call's boolean workspace-isolation choice passes through without workflow
  inference, and requested isolation fails closed in DurableAgent.
- Isolated calls return durable workspace artifacts that later calls can consume
  to work with retained branches.
- Scoped model-and-thinking pair enforcement applies to live child work.
- Changed inherited model-and-thinking pairs invalidate call compatibility.
- Child orchestration tools remain unavailable.
- UI absence does not prevent background or restored operation.

## Open Decisions

- Exact workflow file shape and exported entry points.
- Exact custom workflow operations.
- Metadata inspection context and dummy-value behavior.
- Exact branch, selection, loop, pipeline, and fan-out helpers.
- Stable call-key derivation and optional explicit keys.
- Workflow journal and graph persistence format.
- Workflow run states and user-facing control names.
- Workflow recovery policy configuration.
- Definition, revision, and run storage locations.
- Hierarchical budget configuration and exhaustion behavior.
- Retry classification and default policies.
- Structured-result validation library.
- Workflow bundle packaging, ingestion, and export behavior.
