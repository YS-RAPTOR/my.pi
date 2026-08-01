# Human-In-The-Loop Service Specification

Status: **Draft**

This document specifies the required behavior of Stratum.pi's shared
human-in-the-loop service and provider service.

The interaction service owns durable request resolution. The provider service
injects compatible human-facing providers into that resolution system.
Producers such as question tools, workflow checkpoints, agents, and permission
extensions retain ownership of their domain semantics.

## Goals

- Accept versioned human-interaction requests from any authorized producer.
- Persist accepted requests and terminal outcomes before notifying consumers.
- Route requests to compatible injected providers without requiring the producer
  to own a live UI.
- Resolve multiple unrelated requests concurrently.
- Prevent two providers or Pi processes from resolving the same request.
- Survive provider reload, producer reload, Pi restart, and process crash.
- Reconcile restored producers through durable request identity rather than
  process-local promises.
- Reject a new request immediately when no live compatible provider exists.
- Keep an already accepted request pending when its provider temporarily
  disappears.
- Validate request and result envelopes against an exact schema version.
- Preserve enough ownership identity to deliver a result only to the producer
  operation that created the request.
- Support TUI, RPC, web, and future provider implementations without embedding
  their presentation logic in the interaction service.

## Non-Goals

- The HITL service does not implement permission policy.
- The HITL service does not rewrite or authorize tool inputs.
- The HITL service does not decide workflow checkpoint meaning, replay, defaults,
  or failure behavior.
- The HITL service does not decide how questionnaire answers affect a model
  conversation.
- The HITL service does not own agent or workflow lifecycle.
- The HITL service does not invent an answer or silently approve a request when
  no provider is available.
- The HITL service does not require all providers to share one UI toolkit.
- Process-local notifications are not the durable source of truth.

## Core Concepts

A producer is an extension or runtime operation that needs a human result.

An interaction schema is one exact versioned contract for a request payload and
its valid result payload. Examples may include `questionnaire/v1`,
`permission/v1`, and `workflow-checkpoint/v1`.

An interaction request is the durable record created for one producer operation.
It has one immutable request payload and at most one terminal outcome.

A provider is a trusted adapter that can present and resolve one or more exact
interaction schema versions through TUI, RPC, web, or another human-facing
channel.

A provider registration is one live provider generation, its capabilities,
scope, priority, and concurrency capacity.

A claim is a leased, exclusive right for one provider generation to present and
resolve one request.

A live waiter is an optional process-local convenience that waits for a request
outcome. The waiter is never the durable contract.

An interaction notification tells live consumers that durable state changed.
Notifications may be duplicated or missed and must never be treated as the
authoritative request record.

## Service Boundaries

### Interaction Service

The interaction service owns:

- Request submission and idempotency.
- Durable request and outcome persistence.
- Request state transitions.
- Producer ownership and cancellation authority.
- Lookup and recovery reconciliation.
- Deadline and expiry processing.
- Live-waiter notification.
- Durable audit history.

### Provider Service

The provider service owns:

- Provider registration and disposal.
- Schema-version capability matching.
- Provider generation and availability tracking.
- Provider scope, priority, and concurrency capacity.
- Atomic request claims and claim leases.
- Claim renewal, release, and recovery.
- Provider response validation and submission.
- Protection against stale or duplicate provider resolution.

These may be implemented by one extension and persistent store, but their
behavioral responsibilities remain distinct.

### Producers

The producer owns:

- The domain-specific request payload.
- The meaning of the result.
- Any default, retry, fallback, or failure behavior.
- The producer operation's durable idempotency key.
- Cancellation when its owning operation no longer needs an answer.
- Replay or application of the resolved result to its own durable state.

A provider-unavailable, rejected, cancelled, or expired outcome is data for the
producer to interpret. The HITL service does not apply a domain fallback.

## Interaction Contracts

Every request identifies one exact schema name and version. Compatibility is
exact unless that schema's contract explicitly defines compatible versions.
Providers must not claim support for an unknown or partially compatible payload.

The service validates persisted request and result envelopes with the canonical
contract for that schema version. Every request persists the exact contract
fingerprint resolved at submission. Providers may claim it only when they
advertise that same fingerprint. Multiple providers for the same schema version
must use the same contract identity.

A schema name and version remains reserved to one fingerprint while any request
or retained outcome depends on it. A different contract requires a new schema
version and cannot replace the validator needed to restore or audit existing
records.

The exact schema language and registration API are deferred. Behaviorally, each
contract must validate:

- The request payload.
- The result payload.
- The allowed result variants, including any domain-specific decline or cancel
  result.
- A stable contract fingerprint.

Generic producer cancellation is distinct from a domain result whose payload
means that the human declined or cancelled a dialog.

## Request Identity And Ownership

Each accepted request receives a globally unique request ID.

The producer also supplies a durable idempotency key scoped to its exact owning
operation. Resubmitting the same key and identical immutable request returns the
existing request. Reusing the key with a different schema name, version,
fingerprint, payload, owner, or deadline is an idempotency conflict and must not
create another request.

A request records enough identity to prove its destination where applicable:

- Project.
- Producer extension and service generation.
- Parent Pi session.
- Workflow run, revision, call, or checkpoint.
- Logical agent, attempt, and child session.
- Producer-defined correlation identity.

Not every producer uses every field. Fields required by that producer's recovery
contract must be present before acceptance.

Knowing a request ID is not cancellation or consumption authority. Cancellation,
result application, and ownership-sensitive lookup require proof of the owning
producer operation or its registered recovery authority.

Producer authority has a stable owner identity, current generation, and leased
recovery claim. A replacement generation must claim that owner identity through
its registered authority before cancelling requests or applying results. The
takeover fences the old generation immediately. Stale producer generations may
observe authorized redacted state but cannot cancel, consume, or apply an
outcome.

## Submission Behavior

Submission performs these steps atomically where required:

1. Validate the generic request envelope and producer authority.
2. Reconcile the producer's idempotency key.
3. Resolve the exact interaction contract.
4. Validate the domain request payload.
5. Determine whether at least one live provider is compatible and in scope.
6. Persist either an accepted pending request or a terminal rejection.
7. Notify eligible providers and any live producer waiter.

Malformed calls that cannot establish identity are operation errors and need not
create a durable request.

A valid new request with no live compatible provider is immediately persisted as
rejected with an actionable reason such as:

- No compatible provider registered.
- No compatible provider in the request's project or session scope.
- Provider service unavailable after initialization.

An unknown schema or version cannot resolve a canonical contract fingerprint and
is therefore an operation error rather than a durable interaction request. No
request record is created.

Provider capacity exhaustion is not provider absence. If a compatible live
provider exists but is busy, the request is accepted and remains pending.

The provider service has explicit initializing, ready, and failed readiness
states. During initializing, a new submission returns a retryable
`provider_service_not_ready` operation error and creates no request. Readiness
must settle rather than leaving submissions waiting indefinitely. In ready state,
normal compatibility rules apply. In failed state, a valid identifiable
submission is durably rejected as provider-service unavailable.

Persisted accepted requests restored during startup are never rejected merely
because providers have not re-registered yet.

## Request States

The durable request states are:

| State | Meaning |
| --- | --- |
| Pending | Accepted and waiting for an eligible provider claim |
| Claimed | One provider generation holds the active claim lease |
| Resolved | A valid provider result was durably accepted |
| Rejected | Submission could not be accepted or routed |
| Cancelled | The owning producer ended the request before resolution |
| Expired | The request deadline elapsed before resolution |

Resolved, rejected, cancelled, and expired are terminal.

A terminal transition is persisted before waiters, producers, providers, or UIs
are notified. Exactly one terminal transition may win. An owner-authorized
cancellation or expiry operation that loses the race returns the already
persisted outcome without replacing it. Provider resolution retries follow the
stricter resolution identity rules below: only an identical retry is
acknowledged, while conflicting or differently terminal submissions are
rejected.

Claim expiry or provider release moves a claimed request back to pending. It is
not a terminal request failure.

## Provider Registration

A provider registration includes:

- Stable provider identity.
- Current provider generation.
- Supported schema names, versions, and contract fingerprints.
- Project, session, or global scope where applicable.
- Presentation modes it can serve.
- Maximum concurrent claims.
- Selection priority.
- Lease renewal and disposal behavior.

Registrations are live capabilities, not permanent authorization. Provider
reload creates a new generation. A stale generation or stale disposer cannot
remove, renew, or resolve work owned by a newer generation.

Provider registrations are durable leased liveness records visible to every Pi
process sharing the project. They identify the owning process, provider
generation, heartbeat, and lease expiry. Abrupt process loss makes the
registration ineligible when its lease expires. Submission and claiming inspect
non-expired registrations at their atomic decision point, so another process
neither overlooks a live provider nor accepts because of an expired one.

A provider must finish registration before it is considered available for new
submissions. Disposal stops new claims and releases active claims when possible.
Abrupt provider loss leaves claims to expire safely.

Provider registration may inject request presentation and response collection
behavior into the provider service. It must not inject permission policy,
workflow semantics, or producer fallback behavior into the interaction service.

## Provider Selection And Claims

Only providers matching the exact schema contract and request scope are eligible.

The provider service selects eligible work without a global one-interaction
lock. Selection respects provider capacity and should avoid starvation. Exact
priority and fairness algorithms are deferred, but they must be deterministic
when the same durable state and live registrations are observed.

A provider must atomically claim a request before presenting it. Presentation
without a valid claim is prohibited.

Each claim records:

- Request ID.
- Provider identity and generation.
- Claim token.
- Claim creation and lease-expiry times.
- Owning Pi process where applicable.

Only the current claim token and provider generation may renew, release, or
resolve the claim. A claim token is scoped to one request and cannot be reused.

The claim mechanism must work across Pi processes. Two providers must never hold
simultaneously valid claims for the same request.

If a provider loses its UI, cannot continue presentation, or intentionally
abandons the request without a domain result, it releases the claim. The request
returns to pending and another compatible provider may claim it.

If all compatible providers disappear after acceptance, the request remains
pending until a provider returns, the producer cancels it, or its deadline
expires.

## Concurrent Interactions

The service supports multiple pending and claimed requests at the same time.
Requests from different workflows, agents, sessions, projects, and producers do
not block one another merely because they require human input.

Provider capacity controls presentation concurrency:

- A TUI provider may declare capacity one and present requests sequentially.
- A web or RPC provider may claim and display several requests concurrently.
- Different providers may resolve unrelated requests simultaneously.
- Parallel workflow children may each retain an independent pending request.
- One producer may submit multiple requests when its own domain rules allow it.

Capacity is enforced against active claims, not the number of pending requests.
The service must not exceed a provider's declared capacity during competing
claims from multiple processes.

No ordering guarantee may be inferred from resolution time. Producers correlate
results only through request and owner identity.

## Resolution

A provider submits a result with the request ID, claim token, provider identity,
provider generation, and deterministic result fingerprint.

Before accepting the result, the provider service must:

1. Check for an existing terminal outcome.
2. Return an idempotent acknowledgement when the persisted resolution has the
   same claim identity and result fingerprint.
3. Reject a conflicting resolution or any other terminal outcome.
4. Verify the non-terminal request is currently claimed.
5. Verify the claim token, provider identity, and generation.
6. Verify the claim lease is still valid.
7. Validate the result against the request's persisted contract fingerprint.
8. Persist the result, resolution identity, and resolved state atomically.
9. Release claim capacity.
10. Notify the owning producer and live observers.

Invalid results do not resolve the request. The provider receives validation
diagnostics and may retry while its claim remains valid.

A resolution repeated with the same request, claim, and identical result is
idempotent even though the request is already terminal and no longer actively
claimed. Its acknowledgement does not expose owner-only result data. A different
late or duplicate result is rejected and cannot replace the persisted outcome.

The producer consumes the persisted result through owner-authorized lookup or
reconciliation. Delivery notifications are at-least-once hints; consuming a
notification is not required for the result to remain available.

## Cancellation And Expiry

Only the owning producer or its registered recovery authority may cancel a
request. Provider disappearance is not producer cancellation.

Cancellation of a pending or claimed request:

- Persists the cancelled terminal state.
- Invalidates any active claim.
- Releases provider capacity.
- Notifies the provider so it can dismiss presentation.
- Rejects late provider results.

A request may carry a durable deadline. Expiry applies the same terminal safety
rules as cancellation and is based on persisted time rather than a process-local
timer alone.

The producer owns any default or fallback after cancellation, rejection, or
expiry. Providers cannot apply a producer default on the producer's behalf.

## Reload, Restart, And Crash Recovery

On restoration, the interaction service:

1. Loads durable requests and resolves each persisted contract fingerprint.
2. Fails closed and quarantines delivery when the exact validator is unavailable.
3. Validates durable non-terminal requests with that exact contract.
4. Preserves terminal outcomes unchanged.
5. Reconciles active claim leases.
6. Returns expired or invalid claims to pending.
7. Waits for current provider generations to register.
8. Re-notifies eligible providers after provider initialization.
9. Reconnects producer waiters only as a convenience.

An accepted request survives producer replacement and UI replacement unless the
producer's lifecycle contract explicitly cancels it. A producer that restarts
first acquires the producer recovery claim, fencing its old generation, then
looks up the durable request by request ID or idempotency key and consumes the
persisted outcome or continues waiting.

An accepted request is not rejected merely because no provider is present during
recovery. Immediate provider-unavailable rejection applies only to new
submissions after provider initialization.

If persistence is corrupt or ownership cannot be proven, the service fails
closed with diagnostics and does not deliver the request or result to another
owner.

## Provider Presentation

Providers own presentation state, navigation, localization, and user-input
collection. The interaction service owns none of those UI details.

Providers receive only requests allowed by their schema capability and scope.
They must treat payload content as untrusted and avoid presenting secrets outside
the authorized project or session context.

Closing or replacing a provider UI does not cancel a request. The provider either
retains and renews its claim or releases it for another provider. A provider may
return a domain-defined decline or cancel result only when the interaction
contract permits that result.

The RPIV Ask User Question frontend may implement a `questionnaire/v1` provider
with tabs, previews, multi-select, custom answers, notes, and review. Those
features belong to that provider and schema, not the generic HITL service.

## Observability

The service exposes read-only projections of:

- Pending, claimed, and terminal requests.
- Producer and project ownership.
- Schema name and version.
- Provider eligibility and current claim.
- Queue age, deadline, and claim lease.
- Resolution, rejection, cancellation, and expiry diagnostics.
- Provider registrations, generations, capacity, and health.

Payload and result visibility follows current authorization and redaction policy.
Observability must not leak one project's interaction content into another.

Notifications may announce submission, claim, release, resolution, rejection,
cancellation, expiry, and provider registration changes. Consumers reconstruct
truth from durable state after missed or duplicated notifications.

## Retention And Deletion

Resolved, rejected, cancelled, and expired records are retained long enough for
producer recovery and audit. Retention duration and storage format are deferred.

Deleting or expiring an audit record must not occur while an owning workflow,
agent, or session still requires it for durable reconciliation. Producers expose
when that dependency has ended.

Deleting a project or owning durable run must cancel its non-terminal requests
before interaction records are removed or tombstoned.

## Failure Behavior

The service fails closed when it cannot prove request ownership, schema identity,
provider compatibility, claim ownership, result validity, or terminal-state
exclusivity.

Persistence failure prevents acceptance, claim, renewal, cancellation, expiry,
or resolution from being reported as successful.

Provider exceptions do not resolve requests. The provider may retain its claim
while retrying or release it. Repeated provider failure is surfaced to operators
but does not invent a producer result.

An unavailable optional observer or UI projection does not invalidate durable
service operation.

## Expected Consumers

### Question Systems

A question tool submits a questionnaire request and interprets the provider's
validated structured answer. The HITL service does not define question count,
options, previews, notes, or conversation formatting.

### Workflow Checkpoints

A workflow submits a request using stable checkpoint identity. The workflow owns
hashing, replay, defaults, timeouts, and branch meaning. An unchanged resolved
checkpoint consumes its persisted workflow answer without resubmitting the HITL
request.

### Durable Agents

An agent request includes logical agent, attempt, child-session, and parent
identity. DurableAgent reconciles resolved prior-attempt requests and cancels
unanswered prior-attempt requests before creating a continuation attempt. The
HITL service never transfers an answer to another attempt identity.

### Permission Systems

A permission extension may submit an `ask` decision through a permission schema.
Permission rules, authorization, session approvals, and tool-input rewriting are
outside this specification and belong in a separate permission specification.

## Required Test Areas

- Valid request acceptance and durable pending state.
- Unknown schema or version failing without creating a request record.
- Immediate rejection when no live compatible provider exists.
- Busy compatible providers causing pending acceptance rather than rejection.
- Persisted accepted requests surviving temporary absence of every provider.
- Startup restoration not rejecting requests before provider registration.
- Request and result schema validation.
- Requests pinning and restoring their exact contract fingerprint.
- Conflicting contract fingerprints being rejected.
- Idempotent resubmission returning the same request.
- Idempotency-key conflict not creating a duplicate request.
- Exact owner authorization for lookup, cancellation, and result consumption.
- Producer replacement claims fencing stale producer generations.
- Multiple concurrent pending and claimed requests.
- Provider capacity enforcement across competing processes.
- Atomic single-provider claim behavior.
- Claim renewal, release, expiry, and reclaim.
- Stale provider generations and disposers being rejected.
- Provider reload preserving accepted requests.
- Cross-process provider-registration leases governing live availability.
- Provider crash returning work to pending after lease expiry.
- Valid resolution persisting before notification.
- Invalid provider results leaving the request unresolved.
- Duplicate identical resolution being idempotent.
- Conflicting or late resolution being rejected.
- Losing cancellation and expiry operations returning the persisted terminal
  outcome without replacing it.
- Cancellation racing resolution with exactly one terminal winner.
- Expiry racing claim or resolution with exactly one terminal winner.
- Provider loss after acceptance not becoming terminal rejection.
- UI closure releasing or retaining a claim without cancelling the request.
- Producer restart reconciling by request ID or idempotency key.
- Missed and duplicated notifications not changing durable truth.
- Cross-project request and payload isolation.
- Agent attempt identity preventing answer transfer after continuation.
- Workflow owner replacement preserving unanswered checkpoints.
- Project or run deletion cancelling non-terminal requests before cleanup.

## Open Decisions

- Exact service API and package names.
- Exact schema language, codec registration, and fingerprint format.
- Persistence root, record format, and project identity derivation.
- Claim lease duration and heartbeat cadence.
- Exact provider-readiness API and initialization deadline.
- Provider priority and fairness algorithm.
- Default provider concurrency capacity.
- Default request deadline behavior.
- Retention duration and tombstone policy.
- Redaction and payload-encryption policy.
- Exact TUI, RPC, and web provider adapters.
- Whether provider health diagnostics are durable or projected only.
