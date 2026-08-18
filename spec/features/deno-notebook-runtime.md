# Deno Notebook Runtime

**Status:** Accepted design

## Purpose

Provide Pi with persistent, stateful Deno Jupyter notebooks that the model controls through a small tool surface. The runtime is the foundation for a future recursive language-model system, but v1 is a notebook runtime rather than an RLM.

A notebook preserves live Deno state while its kernel exists and preserves an execution journal after the kernel closes. Closed kernels are terminal and cannot be revived.

## Goals

- Execute model-authored TypeScript and JavaScript in Deno Jupyter kernels.
- Preserve variables, imports, functions, and other runtime state between cells in the same live notebook.
- Run different notebooks concurrently while allowing only one active cell per notebook.
- Retain cell source, output, errors, rich results, and lifecycle history after closure.
- Make large output pageable without exposing its physical storage layout to `wait` callers.
- Keep creation, execution, waiting, stopping, and discovery explicit.
- Keep v1 trusted and operationally simple.

## Non-goals

- Reviving, replaying, serializing, or snapshotting a closed kernel.
- Rolling notebook state back when Pi navigates its conversation tree.
- Sandboxing model-generated code.
- Tracking every promise, timer, subprocess, or background task created by a cell.
- Sharing or transferring live kernels across Pi forks.
- Automatically injecting Pi user messages or conversation history into a kernel.
- Enforcing global storage or memory quotas.
- Automatic artifact deletion or garbage collection.
- Power-loss durability for every output event.
- Recursive agents, permission brokering, or `.ipynb` export in v1.

## Domain language

**Notebook**: A live Deno Jupyter kernel together with its durable artifact directory. A notebook is reusable while live and terminal after closure.

**Cell**: One execution request admitted to a notebook. A notebook owns at most one running cell.

**Current notebook**: The notebook selected implicitly when `start_cell` omits `notebook_id`.

**Notebook artifact**: The directory whose name is the notebook ID and which contains the notebook journal and external output payloads.

**Journal**: The authoritative append-only JSONL history of a notebook. It records execution history but cannot reconstruct runtime state.

**Output event**: One Jupyter output message received by the host. Source-level calls such as `console.log()` are not guaranteed to map one-to-one to output events.

**MIME bundle**: The alternative representations emitted together by a Jupyter result or display event.

**MIME group**: An ordered, named policy grouping of MIME patterns. The first matching group owns storage accounting and delivery behavior for a payload.

**Storage limit**: A cumulative per-cell logical-payload allowance for a MIME group.

**Delivery limit**: A non-destructive policy controlling how stored output is returned by one `wait` response.

**Indivisible output**: A delivered MIME item that cannot be cursor-split. A `wait` response contains at most one indivisible item.

## Runtime shape

```text
Pi session
├── currentNotebookId
├── live notebook limit: 5 by default
└── notebooks
    ├── nb_<generated-id>
    │   └── Deno Jupyter kernel
    └── nb_<generated-id>
        └── Deno Jupyter kernel
```

Notebook and cell IDs are host-generated, immutable, and type-tagged:

```text
nb_<unique-id>
cell_<unique-id>
```

Tool inputs parse these prefixes strictly. They do not search multiple registries and guess the target type.

Notebook names are optional, immutable, non-unique display labels. Tools always target IDs.

## State model

### Notebook states

```text
idle
  No cell is running. The notebook accepts a cell.

busy
  Exactly one cell is running. New cells are rejected.

closed
  The kernel is dead. The artifact remains readable, but the kernel cannot revive.
```

### Cell states

```text
running
succeeded
failed
interrupted
```

### Core transitions

```text
start cell
  notebook: idle → busy
  cell: created → running

cell completes normally
  cell: running → succeeded
  notebook: busy → idle

cell throws
  cell: running → failed
  notebook: busy → idle

stop cell succeeds
  cell: running → interrupted
  notebook: busy → idle

stop cell cannot interrupt kernel
  cell: running → interrupted
  notebook: busy → closed/unresponsive

stop notebook
  active cell, if any: running → interrupted
  notebook: idle|busy → closed/manual

kernel crash
  active cell, if any: running → failed
  notebook: idle|busy → closed/crashed

journal storage fails
  active cell: running → failed/storage_failure
  notebook: busy → closed/storage_failure
```

A normal exception or successful interruption does not roll back kernel state. Partially mutated variables and other side effects remain available to later cells.

A cell succeeds when its Jupyter execution request completes. Unawaited promises, timers, subprocesses, and other background work are not tracked and may continue after cell completion.

## Provider tool surface

V1 exposes five tools and replaces Pi's normal model-facing tools.

### `create_notebook`

```ts
create_notebook({
  name?: string
})
```

Creation:

1. Rejects when the configurable live-kernel count is already reached.
2. Allocates a system-generated notebook ID and artifact directory.
3. Starts and health-checks a Deno Jupyter kernel.
4. Makes the notebook current.
5. Returns only after `idle` means ready for execution.

If startup fails, retain the artifact and diagnostics, mark the notebook `closed/startup_failed`, and return an error containing the notebook ID and artifact directory.

Never close an idle notebook automatically to free a slot.

### `start_cell`

```ts
start_cell({
  code: string,
  notebook_id?: string
})
```

Notebook resolution:

```text
explicit existing idle ID  → execute there and make it current
explicit unknown ID        → error
explicit closed ID         → error
omitted ID + current idle   → execute in current notebook
omitted ID + no current     → error
omitted ID + current closed → error
```

There is no implicit notebook creation and no upsert behavior.

Admission order:

```text
validate notebook exists and is idle
  → reserve notebook as busy
  → allocate cell ID
  → journal cell source before execution
  → send Jupyter execute request
  → return cell ID
```

Successful tool execution means the cell was admitted, not that it completed. The cell may become terminal before the tool result reaches the model.

A busy notebook rejects another cell. There is no hidden queue. Different notebooks may execute concurrently.

If submission fails after journaling the cell, preserve the cell ID, mark it failed with an admission failure, and close the notebook if its kernel connection was lost.

There is no automatic cell-execution timeout.

### `wait`

```ts
wait({
  cell_id: string,
  cursor?: string,
  timeout_ms?: number
})
```

`wait` is both a status waiter and a pageable reader for one cell.

Blocking behavior:

```text
cell already terminal
  → return immediately

cell running
  → wait for terminal status, timeout, or Pi cancellation
  → captured output does not wake the call
```

Unread output that already exists does not cause an early return while the cell is running. `timeout_ms: 0` is the explicit immediate-poll mechanism.

Defaults:

```text
timeout_ms omitted → 10 seconds
timeout_ms = 0     → immediate poll
maximum timeout    → configurable; 5 minutes by default
```

Pi cancellation stops only the active `wait` call. It does not interrupt or otherwise mutate the cell. Stopping execution requires `stop`.

A result contains:

- the current cell status;
- a bounded sequence of text and image content blocks;
- the next cursor;
- `has_more`.

No return-reason field is required. A returned `running` status means the requested wait duration elapsed. Pi cancellation aborts the tool call rather than producing an ordinary result.

`has_more` means already-captured output remains beyond the returned page. It says nothing about output that a running cell may emit later.

A terminal cell with `has_more: true` remains immediately pageable through subsequent calls.

Cell execution failure remains readable and pageable. Exact machine-readable error codes and Pi tool-error boundaries are implementation details.

### Cursor

A cursor is scoped to its `cell_id` and addresses cell-local output events:

```text
e7:l20          output event 7, next unread logical line 20
e7:l20:b51200   output event 7, line 20, next unread UTF-8 byte 51,200
```

Positions are zero-based.

- Ordinary textual output is split at line boundaries.
- A byte position is used only when one logical line exceeds the text delivery byte limit.
- Text slicing stops on valid UTF-8 boundaries.
- Indivisible output advances the cursor to the following event.
- A malformed cursor or a cursor used with another cell is rejected.
- Existing output prefixes are stable.
- Repeating a cursor while a cell is running may return a longer suffix later because new output has been captured.

### `stop`

```ts
stop({
  id: string, // nb_* or cell_*
});
```

Stopping is idempotent. Stopping an already-terminal target succeeds without changing it.

Stopping a running cell:

```text
send Jupyter interrupt
  → wait configurable grace period, 5 seconds by default
  → if cell terminates: notebook becomes idle
  → otherwise: kill kernel process group and close notebook/unresponsive
```

If a cell finishes normally during the interrupt race, preserve its actual terminal status.

Stopping a notebook interrupts any active cell, shuts down the kernel, and marks the notebook `closed/manual`.

Kernel closure performs best-effort process-group termination. Trusted code may deliberately detach subprocesses or create external side effects that outlive the notebook; closure is not a sandbox guarantee.

### `list_notebooks`

```ts
list_notebooks({
  name?: string,
  status?: "idle" | "busy" | "closed"
})
```

The tool supports filtering by exact display name and status. Names are non-unique, so a name filter may return multiple notebooks. Results include enough lifecycle and discovery metadata to identify and use the artifact:

```ts
{
  id: string
  name?: string
  status: "idle" | "busy" | "closed"
  current: boolean
  artifact_path: string
  active_cell_id: string | null
  created_at: string
  updated_at: string
  close_reason?: string
}
```

`artifact_path` is the notebook directory, not the JSONL path.

The list includes notebooks belonging to the current Pi session lineage: notebooks created in the current session and closed notebook artifacts inherited through fork or clone ancestry. Unrelated sessions are excluded.

Historical cell discovery is performed by reading the journal with code rather than embedding every cell in list results.

## Artifact and journal model

The notebook directory name is the notebook ID:

```text
notebooks/
└── nb_<generated-id>/
    ├── notebook.jsonl
    └── payloads/
        └── cell_<generated-id>/
            └── external event payloads
```

The artifact directory is retained indefinitely unless the user or trusted AI code deletes it. There is no TTL, garbage collector, deletion tool, or automatic quota cleanup.

A live notebook can use Deno code to read, transform, summarize, or delete a dead notebook artifact. A dead kernel is never revived for this purpose.

### Journal guarantees

- JSONL is authoritative and append-only.
- Cell source is recorded before execution is requested.
- Every record has notebook-wide ordering and a host-observed timestamp.
- Cell output records additionally have cell-local output ordering used by cursors.
- Display updates and `clear_output` are appended chronologically rather than rewriting earlier records.
- `wait` presents this chronological output. A future exporter may resolve updates into a final visual view.
- The exact JSONL event union and exact error-code vocabulary are decided during implementation.
- The notebook ID need not be duplicated in records because the artifact directory is the identity.
- Cell IDs and event types belong to the event variants that require them rather than a flat common envelope.
- Output is written promptly, and normal terminal completion flushes preceding output.
- No per-event power-loss durability is promised.
- Journals are host-managed by convention but are not protected from trusted notebook code.

If a live journal becomes missing or unwritable, fail the active cell and close the notebook with `storage_failure`.

If a closed artifact is deleted, its history is permanently gone and it disappears from discovery after Pi reload.

If a closed journal is malformed, discovery reports corruption and does not guess, repair, replay, or revive it.

If the host dies with a journal that says a cell is still running, later discovery records the cell and notebook as terminal with `runtime_lost`. It never replays the code.

## Output capture

Capture all relevant Jupyter output categories:

- stdout;
- stderr;
- execution errors and stacks;
- final-expression results;
- explicit display data;
- display updates;
- clear-output events;
- rich MIME bundles.

Normal Jupyter final-expression semantics apply automatically. Code does not need an explicit host helper to publish the final value.

One received Jupyter message is one output event. The runtime does not promise that one source-level logging call always equals one event.

### Inline and external storage

Each output event is represented in the journal, either inline or by reference.

```text
payload ≤ 2,000 lines and ≤ 50 KB
  → inline JSONL

payload exceeds either threshold
  → external payload file
  → JSONL reference
```

Externalization is decided per event. A configurable cumulative per-cell inline threshold prevents millions of individually small events from making the main journal unreasonably large. Its exact default is an implementation configuration decision.

Physical inline/external placement is invisible to `wait` callers.

Storage admission is atomic per Jupyter event and MIME bundle:

```text
every payload fits its remaining MIME-group allowance
  → retain the complete event

any payload exceeds its allowance
  → reject the complete event
  → interrupt cell
  → cell failed/output_limit_exceeded
  → notebook idle
```

Previously accepted events remain retained. The offending event is not partially stored, including when it is textual.

Storage accounting uses logical payload bytes, not JSON escaping, JSONL envelope overhead, or external-file representation.

There is no global artifact-storage cap and no global runtime-memory cap. Physical disk exhaustion is fatal to the active notebook because truthful journaling can no longer be guaranteed.

## MIME policy

Storage and delivery behavior share one ordered object-based configuration. Every group has a unique name. The first matching group wins, and a final fallback group is required.

Default policy:

```ts
const mimeGroups = [
  {
    name: "text",
    mimes: ["text/*", "application/json"],
    storage: {
      maxPayloadBytes: 1536 * MiB,
    },
    delivery: {
      type: "text",
      maxLines: 2_000,
      maxBytes: 50_000,
    },
  },
  {
    name: "images",
    mimes: ["image/*"],
    storage: {
      maxPayloadBytes: 384 * MiB,
    },
    delivery: {
      type: "image",
      maxWidth: 1_600,
      maxHeight: 1_600,
    },
  },
  {
    name: "fallback",
    mimes: ["*/*"],
    storage: {
      maxPayloadBytes: 128 * MiB,
    },
    delivery: {
      type: "metadata",
    },
  },
];
```

These defaults total 2 GiB of possible retained output per cell. Custom group limits may sum to any value.

Stdout and stderr are charged to the text group as `text/plain`.

Storage usage is cumulative per cell and per matched group. All unknown MIME values share the fallback group's finite allowance rather than dynamically receiving separate limits.

Pi owns configuration loading, validation, and reload. Runtime policy does not change while a Pi session is active. Reload stops all notebooks, after which the new Pi configuration applies. The notebook runtime does not duplicate Pi's resolved policy into each journal.

### MIME bundle retention and projection

Store the complete MIME bundle atomically. For `wait`, choose one representation using a deterministic, configurable, wildcard-aware preference order.

Default preference:

```text
application/json
image/*
text/markdown
text/plain
text/html
*/*
```

Text streams, `text/*`, and JSON rendered as UTF-8 are splittable during delivery. Other MIME payloads are indivisible.

A `wait` response may contain textual output before and after one indivisible item, but never more than one indivisible item. It stops at the text delivery limit or before a second indivisible item.

If the selected representation cannot be sent as a Pi text or image content block, retain the original and return textual metadata describing its MIME type and retained size. The cell does not fail merely because the selected representation is not model-deliverable.

## Image delivery

Image storage retains the original payload. Delivery derivatives are generated on demand and are not persisted.

For supported static images:

- apply orientation metadata;
- fit within the configured maximum width and height;
- preserve aspect ratio;
- never crop;
- never upscale;
- emit one complete image content block.

There is deliberately no encoded-byte delivery cap. Image delivery is constrained by resolution only.

SVG is rasterized to the configured delivery resolution while retaining the original SVG.

Animated images are not delivered as images in v1. Retain the original payload and return metadata through `wait`.

If decoding or conversion fails, retain the original and return metadata rather than failing the cell.

## Pi session lifecycle

```text
/tree
  → keep live kernels
  → retain the same current-notebook pointer
  → do not roll back notebook state

/fork or /clone
  → close all live kernels
  → replacement session can list/read inherited dead artifacts

/new or /resume
  → close all live kernels

/reload
  → Pi closes all live kernels as part of session reload

quit
  → close all live kernels
```

Conversation branching does not branch notebook state:

```text
branch A sets x = 42
/tree returns to an earlier conversation entry
branch B still observes x = 42
```

Notebook journals likewise contain cells produced across conversation branches. This is intentional; runtime snapshots and branch isolation are non-goals.

The v1 session model does not include control of kernels owned by another Pi process.

## User-message boundary

Pi user messages follow the ordinary Pi model path:

```text
user message
  → Pi model
  → explicit start_cell({ code })
  → Deno kernel
```

The runtime does not automatically inject the latest user message, conversation history, or a prompt variable into notebooks.

A future `agents.run(prompt)` API will likewise receive only prompts explicitly passed by notebook code.

## Security model

V1 is trusted local execution, not a sandbox.

Deno code may access files, network resources, environment variables, subprocesses, and other local capabilities according to the trusted runtime configuration. Closing or interrupting a notebook does not reverse filesystem, process, network, or external-service side effects.

The launcher should support later addition of a Deno external permission broker, but no permission broker or user approval flow is part of v1.

## Acceptance scenarios

### Explicit creation

```text
Given no current notebook
When start_cell omits notebook_id
Then it fails and does not create a notebook

When create_notebook succeeds
Then its ready kernel is idle and current
```

### Busy rejection and concurrency

```text
Given notebook A is busy
When another cell targets A
Then admission is rejected and no cell is created

Given notebook B is idle
When a cell targets B while A is busy
Then B may execute concurrently
```

### Waiting

```text
Given a running cell emits output
Then output alone does not wake wait

When wait reaches its timeout
Then it returns status=running and a bounded output page
And the cell continues running

Given a terminal cell
When wait is called
Then it returns immediately and supports cursor pagination
```

### Output limits

```text
Given a new MIME bundle would exceed a cell's matched storage group
When the bundle arrives
Then the complete bundle is rejected
And the cell fails with output_limit_exceeded
And all previously accepted events remain readable
And the notebook returns to idle
```

### Image delivery

```text
Given a retained static image exceeds delivery resolution
When wait reaches it
Then wait returns a non-persisted aspect-preserving downscaled image

Given an animated image
When wait reaches it
Then wait returns metadata and retains the original payload
```

### Interruption

```text
Given a running cell responds to interrupt
When stop targets the cell
Then the cell becomes interrupted and the notebook becomes idle

Given the kernel ignores interrupt beyond the grace period
Then the kernel process group is killed
And the cell becomes interrupted
And the notebook becomes closed/unresponsive
```

### Session navigation

```text
Given a live notebook
When Pi navigates with /tree
Then the same live runtime remains available without rollback

When Pi forks or clones
Then the kernel closes
And the new session can discover the retained dead artifact
```

### Runtime loss

```text
Given a journal says a cell is running
And no live kernel exists after host recovery
Then the cell and notebook become terminal/runtime_lost
And no code is replayed
```

## Deferred work

- Notebook-callable `await agents.run(...)` and recursive subagents.
- Deno external permission broker and Pi approval UI.
- JSONL-to-`.ipynb` conversion.
- Live-kernel transfer or sharing across forks.
- Exact JSONL discriminated unions.
- Exact machine-readable error-code taxonomy.
- Concrete image codec and rasterization library choices.

## References

- https://github.com/IgorWarzocha/howaboua-pi-stuff
- https://github.com/shift-labs-ai/pi-rlm
- https://github.com/PrimeIntellect-ai/prime-agent
