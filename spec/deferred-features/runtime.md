# Runtime Specification

Status: **Draft**

Stratum.pi is one Effect-powered modular monolith. Its internal systems are focused Effect services composed into one application runtime rather than independently loaded orchestration extensions.

## Effect Runtime

- Stratum.pi uses Effect 4 for typed services, layers, scoped resources, structured concurrency, fibers, queues, deferred values, pub/sub, cancellation, timeouts, retries, schedules, typed operational errors, schema validation, and deterministic test services.
- `effect` and every `@effect/*` package must use the same exact compatible version. The package manifest is authoritative for the selected version.
- One scoped runtime owns the application services for the corresponding Pi session lifetime.
- Pi shutdown disposes the runtime and all scoped resources exactly once.
- Internal services communicate through typed Effect contracts rather than process-global implementation objects.

## Pi Boundary

Pi event handlers, commands, tools, and third-party extension APIs remain ordinary asynchronous TypeScript boundaries. External consumers do not need to understand Effect services, layers, scopes, fibers, or causes.

Boundary adapters validate external input, enter the Effect runtime, and return Pi result objects or explicit asynchronous result unions. Domain failures remain typed rather than relying on untyped Promise rejection.

Pi cancellation is bridged into interruptible Effect execution. Cancelling a Pi operation must interrupt its corresponding Effect work without disposing unrelated runtime services.

## Durable Boundary

Effect fibers, queues, deferred values, scopes, layers, runtime objects, promises, Pi contexts, and model objects are process-local and must never be persisted as durable state.

Durable state uses versioned, schema-validated records with stable IDs and atomic writes. Reload and restart reconstruct process-local Effect coordination from those records.

Effect workflow or cluster packages may be studied as implementation references, but they do not replace Stratum.pi's explicit workflow, agent, interaction, ownership, and recovery protocols.

## Required Tests

- Runtime acquisition and disposal follow the Pi session lifecycle.
- Shutdown disposes scoped resources exactly once.
- Pi cancellation interrupts only the associated Effect operation.
- External boundaries expose no unresolved Effect service requirements.
- Persisted schemas reject process-local runtime values.
- Test layers can replace clocks, IDs, persistence, and infrastructure services deterministically.
