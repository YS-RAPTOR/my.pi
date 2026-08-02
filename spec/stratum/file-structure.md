# Stratum File Structure

Stratum grows through complete capability slices. Files are added only when the current slice needs them; future capabilities and operations do not receive placeholders.

Modules follow OpenCode's Effect shape:

- flat top-level exports;
- `Context.Service` definitions beside implementation layers;
- direct `Layer.effect` declarations with visible dependencies;
- traced public operations;
- self-namespace exports at the bottom of public modules.

Consumers use names such as `Shell.Open`, `Shell.Service`, `Shell.Rpcs`, `Broker.Rpcs`, and `Session.ID`. There are no exported `make` constructors or `Live` layers.

## Current tree

```text
extensions/stratum/
├── package.json
├── tsconfig.json
├── index.ts
│
├── config/
│   └── index.ts
│
├── common/
│   ├── connection.ts
│   └── session.ts
│
├── capabilities/
│   └── shell/
│       ├── index.ts
│       ├── service.ts
│       ├── handlers.ts
│       ├── types.ts
│       ├── rpcs.ts
│       ├── stdio/
│       │   └── index.ts
│       ├── herdr/
│       │   ├── index.ts
│       │   ├── repo.ts
│       │   ├── private.ts
│       │   ├── terminal.ts
│       │   └── launcher.py
│       └── store.ts
│
├── broker/
│   └── index.ts
│
└── client/
    └── index.ts
```

## Package entry point

### `index.ts`

Exports the `Broker`, `Client`, `Connection`, `Session`, and `Shell` namespaces. It retains the default Pi extension export but contains no substantial implementation.

## Configuration

### `config/index.ts`

Defines the shared `Config.Service` and default layer. Stdio queue capacity and Herdr socket request, retry, startup, polling, shutdown, token, and launcher timing limits are acquired through this service rather than module constants. Tests and alternate compositions can provide another `Config.Service` value without changing capability code.

## Common

### `common/connection.ts`

Defines socket path and client-token options shared by broker and client layers.

### `common/session.ts`

Defines `Session.ID`, request header names, request-local `Session.Current`, typed rejection, and Effect RPC middleware.

The common directory has no barrel. Consumers import independent namespaces directly.

## Shell capability

### `capabilities/shell/types.ts`

Owns serializable schema classes for:

- routed resource IDs;
- Open, Snapshot, List, Inspect, Write, CloseStdin, and Signal;
- Snapshot's required nullable line window, where null reads the visible viewport and 1 through 1,000 reads that many recent unwrapped rendered rows;
- lifecycle values;
- terminal snapshots and resource summaries;
- typed operation failures.

It contains no process handles, Herdr identifiers, scopes, fibers, or broker state. There is no Read, byte-write, or resize schema.

### `capabilities/shell/rpcs.ts`

Declares the seven Shell RPCs with `Rpc.make`, applies session middleware, and combines them into `Shell.Rpcs`. Ordered interaction remains client composition rather than a broker RPC.

### `capabilities/shell/stdio/index.ts`

Defines `Stdio.Service` and `Stdio.layer` as the complete stdio-resource factory. The layer owns child-scope creation, secure output-file acquisition, `/bin/bash -c <cmd>` spawning, supervision, process-group signaling, and partial-acquisition cleanup.

Each Open returns an operational `Stdio.Resource`. Its file handle, lifecycle `Ref`, owner `HashSet`, completion `Deferred`, and stdin `Queue` remain private to the constructor closure. The store retains only this operational value and its public resource ID.

The module creates a `0700` temporary directory, opens `output.log` exclusively with mode `0600`, writes the merged output stream, and flushes before completion. There is no source/chunk index or journal read operation. The scoped file handle closes with the resource while the file remains under operating-system temporary-file policy.

A single long-lived stdin stream consumes UTF-8 writes from the bounded queue. Queue completion is the sole stdin-closure authority. Close ends the queue after accepted writes and delivers EOF. Process supervision records running/draining/completed/failed state and closes the child scope.

There are no output cursors, attached consumers, read locks, previews, or line counters. Agents read `output.log` through their ordinary filesystem capability.

### `capabilities/shell/herdr/repo.ts`

Defines the narrow stock-Herdr repository. It uses Effect's scoped Node socket abstraction and owns request framing, response deadlines, response-size bounds, and the small set of session, pane, process, workspace, text, ping, and stop operations used by Stratum. Every repository call receives three retries with a short delay. Exhausted socket failures remain failures and are never treated as authoritative pane disappearance or command completion. Raw Herdr response shapes do not escape this module.

### `capabilities/shell/herdr/private.ts`

Owns lazy private headless-server startup, the private launcher-control Unix socket, command registration, generated configuration, temporary-runtime cleanup, and one private workspace per PTY Open. It validates Effect-tagged launcher reports with Schema classes, makes Open wait for an authoritative `Started` or `StartFailed` report, and exposes exact exit and release operations to the terminal resource. Setup failures become `PtyUnavailable`.

### `capabilities/shell/herdr/launcher.py`

Contains the standalone Python launcher source using only the standard library. Its `main` requires broker control fields in each command descriptor, connects to the broker-private Unix socket, forks Bash into a separate foreground process group within Herdr's PTY session, and obtains authoritative status with `waitpid`. It reports Effect-tagged `Started`, `StartFailed`, and exact `Exited` messages, waits for a `Release`, and then exits. While Bash runs, Linux pidfd and socket readiness provide event-driven command-exit and broker-disconnect detection; broker disconnect kills the command process group without polling. `Herdr.Private` reads the module as a package asset, prepends the Python shebang, and appends the `main` call with injected connection and release timing configuration before materializing it.

### `capabilities/shell/herdr/terminal.ts`

Owns closure-backed terminal resources. Herdr pane identifiers, lifecycle state, ownership, completion notification, cached snapshots, process-group signaling, and Wait behavior remain private. Private PTYs and discovered user panes share this operational interface while retaining different Wait semantics.

Private PTY completion is event-driven from the launcher's authoritative `Exited` report rather than inferred from pane disappearance. On natural completion the supervisor captures up to 1,000 recent unwrapped rows while the launcher keeps the pane alive. Broker-requested signals first capture the same bounded terminal history and then target the registered Bash process group. Final lifecycle state contains the direct Bash wait status, and `Release` is sent only after lifecycle and snapshot finalization. Control or final-capture failure produces a failed lifecycle and never makes Wait report completed. Discovered user-owned panes retain process-observation polling because they have no Stratum launcher.

### `capabilities/shell/herdr/index.ts`

Defines the shallow `Herdr.Service` facade. It composes the repository, private runtime, and terminal-resource factory; routes PTY Open through the private runtime; and discovers panes from inherited `HERDR_SOCKET_PATH`.

### `capabilities/shell/store.ts`

Defines the broker-wide Shell registry. It allocates route-specific resource numbers and stores tagged stdio or terminal entries in an Effect `HashMap` inside a `Ref`.

The store retains only operational resource values and public IDs. Terminal discovery uses stable identity keys so repeated List calls reuse the same `shell:herdr:<number>`.

The store exposes only registration and lookup mechanics. Resource-specific ownership, summaries, controls, and lifecycle remain in their owning modules.

### `capabilities/shell/service.ts`

Defines `Shell.Interface`, `Shell.Service`, and `Shell.layer`. It routes already-resolved Open requests, discovers user panes before List, dispatches operations through stored operational resources, and sorts and filters summaries.

### `capabilities/shell/handlers.ts`

Adapts request-local `Session.Current` values to explicit service arguments and builds the RPC handler layer. It contains no capability state or routing policy.

### `capabilities/shell/index.ts`

Is the shallow public barrel for Shell schemas, RPC declarations, service, handlers, store, and driver namespaces.

## Broker

### `broker/index.ts`

Composes:

- `Broker.Rpcs`, including general `Resource.Wait`;
- resource-ID capability routing;
- session middleware authentication;
- shared Config plus Shell, Store, Stdio, Herdr, and Node layers;
- Shell and Wait handlers;
- Effect RPC socket protocol and NDJSON serialization;
- the Node Unix-domain socket server;
- stale-socket cleanup;
- scoped `Broker.run`.

Effect RPC performs broker dispatch; there is no custom router or envelope.

## Client

### `client/index.ts`

Defines `Client.Interface`, `Client.Service`, and `Client.layer(options)`. It builds the typed Effect RPC client over a Unix socket, attaches session and client-token headers, and exposes `shellOpen`, `shellSnapshot`, `shellList`, `shellInspect`, `shellWrite`, `shellCloseStdin`, `shellSignal`, and general `wait`. The client convenience API makes Snapshot lines optional and resolves omission to the RPC's explicit null visible-view request.

## Removed infrastructure

Effect RPC owns request correlation, interruption, typed exits, routing, socket messages, and NDJSON. Stratum does not define custom protocol/router infrastructure.

The current simplification also removes:

```text
Shell.Read
Shell.WriteText
Shell.WriteBytes
Shell.Resize
output.idx
byte and line cursors
preview and truncation generation
```

## Growth rules

- Keep all PTY behavior behind stock Herdr; do not introduce a local PTY library or Herdr fork.
- Keep downstream Herdr presentation changes independent from Stratum execution.
- Add a binary-input operation only after a concrete non-UTF-8 requirement exists.
- Keep capability state out of RPC handlers and client adapters.
- Extract another shared resource abstraction only after stdio and terminal implementations prove a genuinely common mechanism.
