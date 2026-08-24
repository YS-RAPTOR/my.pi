import * as Pi from "@earendil-works/pi-coding-agent";
import {
  Array as Arr,
  Cause,
  Chunk,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  pipe,
  PubSub,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { Jupyter } from "#o/jupyter";
import { CellOutput } from "#o/output";
import { Prelude } from "#o/prelude";
import { CellId, NotebookId } from "./types.ts";

export class Config extends Data.Class<{
  readonly artifactRoot: string;
  readonly maxLiveNotebooks: number;
  readonly maxWaitMillis: number;
  readonly interruptGraceMillis: number;
}> {}

export class CreateInput extends Data.Class<{
  readonly name: string;
}> {}

export class StartInput extends Data.Class<{
  readonly code: string;
  readonly notebookId: Option.Option<NotebookId>;
}> {}

export class WaitInput extends Data.Class<{
  readonly cellId: CellId;
  readonly cursor: Option.Option<CellOutput.Cursor>;
  readonly timeoutMillis: number;
}> {}

export class ListInput extends Data.Class<{
  readonly name: Option.Option<string>;
  readonly status: Option.Option<"idle" | "busy" | "closed">;
}> {}

export class NotebookSummary extends Data.Class<{
  readonly id: NotebookId;
  readonly name: string;
  readonly status: "idle" | "busy" | "closed";
  readonly current: boolean;
  readonly artifactPath: string;
  readonly activeCellId: Option.Option<CellId>;
  readonly createdAt: string;
  readonly updatedAt: string;
}> {}

export type NotebookStatus = "idle" | "busy" | "closed";
export type CellStatus = "running" | "succeeded" | "failed" | "interrupted";
export type StoppedCellStatus = Exclude<CellStatus, "running"> | "killed";

export class StopCellResult extends Data.Class<{
  readonly before: CellStatus;
  readonly after: StoppedCellStatus;
}> {}

export class StopNotebookResult extends Data.Class<{
  readonly before: NotebookStatus;
  readonly after: "closed";
}> {}

export type WaitEvent = Data.TaggedEnum<{
  content: { readonly value: CellOutput.Content };
  complete: {
    readonly status: CellStatus;
    readonly nextCursor: CellOutput.Cursor;
    readonly hasMore: boolean;
  };
}>;

export const WaitEvent = Data.taggedEnum<WaitEvent>();

export class OperationFailed extends Data.TaggedError("Notebook")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type Interface = Readonly<{
  create: (input: CreateInput) => Effect.Effect<NotebookSummary, OperationFailed>;
  start: (input: StartInput) => Effect.Effect<CellId, OperationFailed>;
  wait: (input: WaitInput) => Stream.Stream<WaitEvent, OperationFailed>;
  stopCell: (id: CellId) => Effect.Effect<StopCellResult, OperationFailed>;
  stopNotebook: (id: NotebookId) => Effect.Effect<StopNotebookResult, OperationFailed>;
  list: (input?: ListInput) => Effect.Effect<Chunk.Chunk<NotebookSummary>, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Notebook.Runtime") {}

class NotebookState extends Data.Class<{
  readonly status: "idle" | "busy" | "closed";
  readonly activeCellId: Option.Option<CellId>;
  readonly updatedAt: string;
}> {}

class Terminal extends Data.Class<{
  readonly status: Exclude<CellStatus, "running">;
  readonly completedAt: string;
  readonly message: Option.Option<string>;
}> {}

class JournalFailed extends Data.TaggedError("NotebookJournalOperationFailed")<{
  readonly message: string;
}> {}

const JournalFields = {
  sequence: Schema.Natural,
  timestamp: Schema.String,
};

class NotebookCreatedRecord extends Schema.Class<NotebookCreatedRecord>("NotebookCreatedRecord")({
  ...JournalFields,
  event: Schema.Literal("notebook_created"),
  name: Schema.String,
}) {}

class CellStartedRecord extends Schema.Class<CellStartedRecord>("CellStartedRecord")({
  ...JournalFields,
  event: Schema.Literal("cell_started"),
  cell_id: CellId,
  code: Schema.String,
}) {}

class CellCompletedRecord extends Schema.Class<CellCompletedRecord>("CellCompletedRecord")({
  ...JournalFields,
  event: Schema.Literal("cell_completed"),
  cell_id: CellId,
  status: Schema.Literals(["succeeded", "failed", "interrupted"]),
  message: Schema.NullOr(Schema.String),
}) {}

export const NotebookJournal = Schema.TupleWithRest(
  Schema.Tuple([Schema.fromJsonString(NotebookCreatedRecord)]),
  [Schema.fromJsonString(Schema.Union([CellStartedRecord, CellCompletedRecord]))],
);

class Resources extends Data.Class<{
  readonly kernel: Jupyter.Handle;
  readonly scope: Scope.Closeable;
}> {}

class Artifact extends Data.Class<{
  readonly directory: string;
  readonly path: string;
  readonly sequence: SynchronizedRef.SynchronizedRef<number>;
}> {}

class Notebook extends Data.Class<{
  readonly id: NotebookId;
  readonly name: string;
  readonly artifact: Artifact;
  readonly createdAt: string;
  readonly status: Ref.Ref<NotebookState>;
  readonly resources: Option.Option<Resources>;
  readonly admission: Semaphore.Semaphore;
}> {}

class Cell extends Data.Class<{
  readonly id: CellId;
  readonly notebookId: NotebookId;
  readonly output: CellOutput.Handle;
  readonly interruptRequested: Ref.Ref<boolean>;
  readonly terminal: Deferred.Deferred<Terminal>;
  readonly completion: Semaphore.Semaphore;
}> {}

class Registry extends Data.Class<{
  readonly notebooks: HashMap.HashMap<NotebookId, Notebook>;
  readonly cells: HashMap.HashMap<CellId, Cell>;
  readonly current: Option.Option<NotebookId>;
  readonly live: number;
}> {}

type JournalEvent = Readonly<Record<string, Schema.Json>>;

const notebookId = Schema.decodeUnknownSync(NotebookId);
const cellId = Schema.decodeUnknownSync(CellId);

const JsonLine = Schema.fromJsonString(Schema.Json);

const now = pipe(
  Clock.currentTimeMillis,
  Effect.map((millis) => new Date(millis).toISOString()),
);

const runtimeFailure = (operation: string, cause: unknown) =>
  new OperationFailed({ operation, message: String(cause) });

export const layer = (config: Config) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const rootScope = yield* Effect.scope;
      const kernels = yield* Jupyter.Service;
      const outputs = yield* CellOutput.Service;
      const prelude = yield* Prelude.Service;
      const preludeSource = yield* prelude.get;
      const files = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;

      const registry = yield* Ref.make(
        new Registry({
          notebooks: HashMap.empty(),
          cells: HashMap.empty(),
          current: Option.none(),
          live: 0,
        }),
      );

      const creation = yield* Semaphore.make(1);

      const journalError = Effect.mapError(
        (cause: unknown) => new JournalFailed({ message: String(cause) }),
      );

      const append = (artifact: Artifact, event: JournalEvent) =>
        SynchronizedRef.updateEffect(artifact.sequence, (sequence) =>
          pipe(
            Effect.gen(function* () {
              const timestamp = yield* now;
              const encoded = yield* Schema.encodeEffect(JsonLine)({
                sequence,
                timestamp,
                ...event,
              });
              yield* files.writeFileString(artifact.path, `${encoded}\n`, {
                flag: "a",
              });
              return sequence + 1;
            }),
            journalError,
          ),
        );

      const removeArtifact = (directory: string) =>
        pipe(
          files.remove(directory, { recursive: true, force: true }),
          Effect.ignore,
        );

      const createArtifact = Effect.fn("Notebook.artifact")(function* (
        id: NotebookId,
        name: string,
      ) {
        const directory = paths.join(config.artifactRoot, id);
        const path = paths.join(directory, "notebook.jsonl");
        yield* pipe(
          files.makeDirectory(config.artifactRoot, {
            recursive: true,
            mode: 0o700,
          }),
          journalError,
        );
        yield* pipe(
          files.makeDirectory(directory, { mode: 0o700 }),
          journalError,
        );
        return yield* pipe(
          Effect.gen(function* () {
            yield* pipe(
              files.writeFileString(path, "", { flag: "wx", mode: 0o600 }),
              journalError,
            );
            const artifact = new Artifact({
              directory,
              path,
              sequence: yield* SynchronizedRef.make(0),
            });
            yield* append(artifact, {
              event: "notebook_created",
              name,
            });
            return artifact;
          }),
          Effect.onError(() => removeArtifact(directory)),
        );
      });

      const getNotebook = (id: NotebookId) =>
        pipe(
          Ref.get(registry),
          Effect.flatMap((state) =>
            Effect.fromOption(() => runtimeFailure("find notebook", `Unknown notebook ID: ${id}`))(
              HashMap.get(state.notebooks, id),
            ),
          ),
        );

      const getCell = (id: CellId) =>
        pipe(
          Ref.get(registry),
          Effect.flatMap((state) =>
            Effect.fromOption(() => runtimeFailure("find cell", `Unknown cell ID: ${id}`))(
              HashMap.get(state.cells, id),
            ),
          ),
        );

      const resources = (notebook: Notebook) =>
        Effect.fromOption(() =>
          runtimeFailure("use notebook kernel", `Notebook ${notebook.id} is closed`),
        )(notebook.resources);

      const summary = Effect.fn("Notebook.summary")(function* (notebook: Notebook) {
        const state = yield* Ref.get(notebook.status);
        return new NotebookSummary({
          id: notebook.id,
          name: notebook.name,
          current: Option.contains((yield* Ref.get(registry)).current, notebook.id),
          artifactPath: notebook.artifact.directory,
          createdAt: notebook.createdAt,
          ...state,
        });
      });

      const idleNotebook = (notebook: Notebook, id: CellId, updatedAt: string) =>
        Ref.update(notebook.status, (state) =>
          state.status === "busy" && Option.contains(state.activeCellId, id)
            ? new NotebookState({
                status: "idle",
                activeCellId: Option.none(),
                updatedAt,
              })
            : state,
        );

      const complete = <E, R>(
        notebook: Notebook,
        cell: Cell,
        terminal: Terminal,
        before: Effect.Effect<void, E, R>,
      ): Effect.Effect<void, E, R> =>
        cell.completion.withPermit(
          Effect.gen(function* () {
            if (yield* Deferred.isDone(cell.terminal)) return;
            yield* before;
            yield* idleNotebook(notebook, cell.id, terminal.completedAt);
            yield* Deferred.succeed(cell.terminal, terminal);
          }),
        );

      const finish = (notebook: Notebook, cell: Cell, terminal: Terminal) =>
        complete(
          notebook,
          cell,
          terminal,
          append(notebook.artifact, {
            event: "cell_completed",
            cell_id: cell.id,
            status: terminal.status,
            message: Option.getOrNull(terminal.message),
          }),
        );

      const closeResources = (notebook: Notebook) =>
        Option.match(notebook.resources, {
          onNone: () => Effect.void,
          onSome: (value) =>
            pipe(
              value.kernel.shutdown,
              Effect.ignore,
              Effect.andThen(Scope.close(value.scope, Exit.void)),
              Effect.ignore,
            ),
        });

      const close = (notebook: Notebook, after: Effect.Effect<void> = Effect.void) =>
        notebook.admission.withPermit(
          Effect.gen(function* () {
            if ((yield* Ref.get(notebook.status)).status === "closed") return yield* after;
            yield* pipe(
              Effect.gen(function* () {
                yield* Ref.set(
                  notebook.status,
                  new NotebookState({
                    status: "closed",
                    activeCellId: Option.none(),
                    updatedAt: yield* now,
                  }),
                );
                yield* Ref.update(
                  registry,
                  (state) => new Registry({ ...state, live: state.live - 1 }),
                );
                yield* after;
              }),
              Effect.ensuring(closeResources(notebook)),
            );
          }),
        );

      const storageFailure = Effect.fn("Notebook.storageFailure")(function* (
        notebook: Notebook,
        cell: Cell,
        cause: JournalFailed,
      ) {
        yield* close(
          notebook,
          complete(
            notebook,
            cell,
            new Terminal({
              status: "failed",
              completedAt: yield* now,
              message: Option.some(cause.message),
            }),
            Effect.void,
          ),
        );
      });

      const recoverStorage =
        (notebook: Notebook, cell: Cell) =>
        <A, R>(self: Effect.Effect<A, JournalFailed, R>) =>
          pipe(
            self,
            Effect.catchTag("NotebookJournalOperationFailed", (cause) =>
              storageFailure(notebook, cell, cause),
            ),
          );

      const crashFailure = Effect.fn("Notebook.crashFailure")(function* (
        notebook: Notebook,
        cell: Cell,
        cause: Jupyter.OperationFailed,
      ) {
        yield* pipe(
          finish(
            notebook,
            cell,
            new Terminal({
              status: "failed",
              completedAt: yield* now,
              message: Option.some(cause.message),
            }),
          ),
          recoverStorage(notebook, cell),
        );
        yield* close(notebook);
      });

      const appendOutput = (cell: Cell, output: Jupyter.Output) =>
        pipe(
          cell.output.append(output),
          Effect.mapError((cause) => new JournalFailed({ message: cause.message })),
        );

      const runCell = Effect.fn("Notebook.runCell")(function* (
        notebook: Notebook,
        cell: Cell,
        execution: Jupyter.Execution,
      ) {
        yield* pipe(
          Effect.all(
            {
              result: execution.completion,
              output: pipe(
                execution.outputs,
                Stream.runForEach((output) => appendOutput(cell, output)),
              ),
            },
            { concurrency: "unbounded" },
          ),
          Effect.flatMap(({ result }) =>
            Effect.gen(function* () {
              const completedAt = yield* now;
              const interrupted = yield* Ref.get(cell.interruptRequested);
              yield* finish(
                notebook,
                cell,
                new Terminal({
                  status:
                    result.status === "succeeded"
                      ? "succeeded"
                      : interrupted
                        ? "interrupted"
                        : "failed",
                  completedAt,
                  message:
                    result.status === "failed" && !interrupted
                      ? Option.fromUndefinedOr(result.reply.evalue)
                      : Option.none(),
                }),
              );
            }),
          ),
          Effect.catchTags({
            NotebookJournalOperationFailed: (cause) => storageFailure(notebook, cell, cause),
            Jupyter: (cause) => crashFailure(notebook, cell, cause),
          }),
        );
      });

      const resolveNotebook = Effect.fn("Notebook.resolve")(function* (
        requested: Option.Option<NotebookId>,
      ) {
        const state = yield* Ref.get(registry);
        const id = yield* pipe(
          requested,
          Option.orElse(() => state.current),
          Effect.fromOption(() =>
            runtimeFailure("resolve current notebook", "No current notebook"),
          ),
        );
        return yield* getNotebook(id);
      });

      const makeNotebook = Effect.fn("Notebook.make")(function* (
        id: NotebookId,
        name: string,
        artifact: Artifact,
        createdAt: string,
        state: NotebookState,
        live: Option.Option<Resources>,
      ) {
        return new Notebook({
          id,
          name,
          artifact,
          createdAt,
          status: yield* Ref.make(state),
          resources: live,
          admission: yield* Semaphore.make(1),
        });
      });

      const discover = Effect.fn("Notebook.discover")(function* () {
        const entries = yield* pipe(
          files.makeDirectory(config.artifactRoot, { recursive: true, mode: 0o700 }),
          Effect.andThen(files.readDirectory(config.artifactRoot)),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
          Effect.mapError((cause) => runtimeFailure("discover notebooks", cause)),
        );
        const ids = Arr.filterMap(entries, (entry) =>
          Schema.decodeUnknownResult(NotebookId)(entry),
        );
        const discovered = yield* Effect.forEach(ids, (id) =>
          pipe(
            Effect.gen(function* () {
              const directory = paths.join(config.artifactRoot, id);
              const path = paths.join(directory, "notebook.jsonl");
              const [created, ...events] = yield* pipe(
                files.readFileString(path),
                Effect.flatMap((source) =>
                  Schema.decodeUnknownEffect(NotebookJournal)(source.trimEnd().split("\n")),
                ),
              );
              const terminals = Arr.reduce(
                events,
                HashMap.empty<CellId, Terminal>(),
                (cells, event) => {
                  const terminal = new Terminal({
                    status: event.event === "cell_started" ? "interrupted" : event.status,
                    completedAt: event.timestamp,
                    message:
                      event.event === "cell_started"
                        ? Option.none()
                        : Option.fromNullOr(event.message),
                  });
                  return event.event === "cell_started"
                    ? HashMap.set(cells, event.cell_id, terminal)
                    : HashMap.modify(cells, event.cell_id, () => terminal);
                },
              );
              const cells = yield* Effect.forEach(
                HashMap.entries(terminals),
                ([cellId, terminal]) =>
                  Effect.gen(function* () {
                    const completed = yield* Deferred.make<Terminal>();
                    yield* Deferred.succeed(completed, terminal);
                    return new Cell({
                      id: cellId,
                      notebookId: id,
                      output: yield* outputs.open(paths.join(directory, cellId), "existing"),
                      interruptRequested: yield* Ref.make(false),
                      terminal: completed,
                      completion: yield* Semaphore.make(1),
                    });
                  }),
              );
              const notebook = yield* makeNotebook(
                id,
                created.name,
                new Artifact({
                  directory,
                  path,
                  sequence: yield* SynchronizedRef.make(events.length + 1),
                }),
                created.timestamp,
                new NotebookState({
                  status: "closed",
                  activeCellId: Option.none(),
                  updatedAt: events.at(-1)?.timestamp ?? created.timestamp,
                }),
                Option.none(),
              );
              return [notebook, cells] as const;
            }),
            Effect.map(Option.some),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
            Effect.mapError((cause) => runtimeFailure("discover notebook", cause)),
          ),
        );
        const restored = Arr.getSomes(discovered);
        const cells = Arr.flatMap(restored, ([, cells]) => cells);
        yield* Ref.set(
          registry,
          new Registry({
            notebooks: HashMap.fromIterable(
              Arr.map(restored, ([notebook]) => [notebook.id, notebook]),
            ),
            cells: HashMap.fromIterable(Arr.map(cells, (cell) => [cell.id, cell])),
            current: Option.none(),
            live: 0,
          }),
        );
      });

      yield* discover();

      const create: Interface["create"] = Effect.fn("Notebook.create")(function* (input) {
        return yield* creation.withPermit(
          Effect.gen(function* () {
            const state = yield* Ref.get(registry);
            if (state.live >= config.maxLiveNotebooks)
              return yield* runtimeFailure(
                "create notebook",
                `The live notebook limit of ${config.maxLiveNotebooks} has been reached`,
              );
            const id = notebookId(`nb_${crypto.randomUUID()}`);
            const createdAt = yield* now;
            const artifact = yield* pipe(
              createArtifact(id, input.name),
              Effect.mapError((cause) => runtimeFailure("create notebook artifact", cause)),
            );
            const scope = yield* Scope.fork(rootScope);
            const opened = yield* pipe(
              Effect.gen(function* () {
                const kernel = yield* kernels.open;
                yield* kernel.initialize(preludeSource);
                return kernel;
              }),
              Scope.provide(scope),
              Effect.exit,
            );
            if (Exit.isFailure(opened)) {
              yield* Scope.close(scope, Exit.void);
              yield* removeArtifact(artifact.directory);
              return yield* runtimeFailure(
                "start notebook kernel",
                Cause.pretty(opened.cause),
              );
            }
            const notebook = yield* makeNotebook(
              id,
              input.name,
              artifact,
              createdAt,
              new NotebookState({
                status: "idle",
                activeCellId: Option.none(),
                updatedAt: createdAt,
              }),
              Option.some(new Resources({ kernel: opened.value, scope })),
            );
            yield* Ref.update(
              registry,
              (value) =>
                new Registry({
                  ...value,
                  notebooks: HashMap.set(value.notebooks, id, notebook),
                  current: Option.some(id),
                  live: value.live + 1,
                }),
            );
            return yield* summary(notebook);
          }),
        );
      });

      const start: Interface["start"] = Effect.fn("Notebook.start")(function* (input) {
        const notebook = yield* resolveNotebook(input.notebookId);
        const live = yield* resources(notebook);

        const cell = yield* notebook.admission.withPermit(
          Effect.gen(function* () {
            const state = yield* Ref.get(notebook.status);
            if (state.status !== "idle")
              return yield* runtimeFailure(
                "start notebook cell",
                `Notebook ${notebook.id} is ${state.status}`,
              );
            const id = cellId(`cell_${crypto.randomUUID()}`);
            const startedAt = yield* now;
            const output = yield* pipe(
              outputs.open(paths.join(notebook.artifact.directory, id)),
              Effect.mapError((cause) => runtimeFailure("create cell output", cause)),
            );
            const cell = new Cell({
              id,
              notebookId: notebook.id,
              output,
              interruptRequested: yield* Ref.make(false),
              terminal: yield* Deferred.make<Terminal>(),
              completion: yield* Semaphore.make(1),
            });
            yield* Ref.set(
              notebook.status,
              new NotebookState({
                status: "busy",
                activeCellId: Option.some(id),
                updatedAt: startedAt,
              }),
            );
            yield* Ref.update(
              registry,
              (state) =>
                new Registry({
                  ...state,
                  cells: HashMap.set(state.cells, id, cell),
                  current: Option.some(notebook.id),
                }),
            );
            return cell;
          }),
        );

        yield* pipe(
          append(notebook.artifact, {
            event: "cell_started",
            cell_id: cell.id,
            code: input.code,
          }),
          Effect.catchTag("NotebookJournalOperationFailed", (cause) =>
            pipe(
              storageFailure(notebook, cell, cause),
              Effect.andThen(Effect.fail(runtimeFailure("journal notebook cell", cause))),
            ),
          ),
        );

        const execution = yield* pipe(
          live.kernel.start(input.code),
          Effect.catch((cause) =>
            pipe(
              crashFailure(notebook, cell, cause),
              Effect.andThen(Effect.fail(runtimeFailure("submit notebook cell", cause))),
            ),
          ),
        );

        yield* pipe(runCell(notebook, cell, execution), Effect.forkIn(live.scope));
        return cell.id;
      });

      const wait: Interface["wait"] = (input) =>
        Stream.callback<WaitEvent, OperationFailed>((queue) =>
          Effect.gen(function* () {
            const cell = yield* getCell(input.cellId);
            const updates = yield* PubSub.subscribe(cell.output.updates);
            const deadline =
              (yield* Clock.currentTimeMillis) +
              Math.max(0, Math.min(input.timeoutMillis, config.maxWaitMillis));

            const consume = (
              cursor: CellOutput.Cursor,
              bytes: number,
              lines: number,
            ): Effect.Effect<void, OperationFailed> =>
              Effect.gen(function* () {
                const sealed = yield* Deferred.isDone(cell.terminal);
                const page = yield* pipe(
                  cell.output.read(
                    new CellOutput.ReadInput({
                      cursor,
                      sealed,
                      maxBytes: Pi.DEFAULT_MAX_BYTES - bytes,
                      maxLines: Pi.DEFAULT_MAX_LINES - lines,
                    }),
                  ),
                  Effect.mapError((cause) => runtimeFailure("read cell output", cause.message)),
                );
                yield* Effect.forEach(
                  page.content,
                  (value) => Queue.offer(queue, WaitEvent.content({ value })),
                  {
                    discard: true,
                  },
                );
                const nextBytes = bytes + page.bytes;
                const nextLines = lines + page.lines;
                const now = yield* Clock.currentTimeMillis;
                if (page.boundary !== "exhausted" || sealed || now >= deadline) {
                  const status: CellStatus = (yield* Deferred.isDone(cell.terminal))
                    ? (yield* Deferred.await(cell.terminal)).status
                    : "running";
                  yield* Queue.offer(
                    queue,
                    WaitEvent.complete({
                      status,
                      nextCursor: page.cursor,
                      hasMore: page.hasMore,
                    }),
                  );
                  return yield* pipe(Queue.end(queue), Effect.asVoid);
                }
                yield* Effect.raceAllFirst([
                  pipe(PubSub.take(updates), Effect.asVoid),
                  pipe(Deferred.await(cell.terminal), Effect.asVoid),
                  Effect.sleep(deadline - now),
                ]);
                return yield* consume(page.cursor, nextBytes, nextLines);
              });

            yield* consume(Option.getOrElse(input.cursor, CellOutput.Cursor.start), 0, 0);
          }).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
        );

      const interrupt = Effect.fn("Notebook.interrupt")(function* (cell: Cell, live: Resources) {
        yield* Ref.set(cell.interruptRequested, true);
        const requested = yield* pipe(
          live.kernel.interrupt,
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!requested) return Option.none<Terminal>();
        return yield* pipe(
          Deferred.await(cell.terminal),
          Effect.timeoutOption(config.interruptGraceMillis),
        );
      });

      const stopCell: Interface["stopCell"] = Effect.fn("Notebook.stopCell")(function* (id) {
        const cell = yield* getCell(id);
        if (yield* Deferred.isDone(cell.terminal)) {
          const terminal = yield* Deferred.await(cell.terminal);
          return new StopCellResult({ before: terminal.status, after: terminal.status });
        }
        const notebook = yield* getNotebook(cell.notebookId);
        const terminal = yield* interrupt(cell, yield* resources(notebook));
        if (Option.isSome(terminal))
          return new StopCellResult({ before: "running", after: terminal.value.status });
        if (yield* Deferred.isDone(cell.terminal)) {
          const completed = yield* Deferred.await(cell.terminal);
          return new StopCellResult({ before: "running", after: completed.status });
        }
        yield* pipe(
          finish(
            notebook,
            cell,
            new Terminal({
              status: "interrupted",
              completedAt: yield* now,
              message: Option.none(),
            }),
          ),
          recoverStorage(notebook, cell),
        );
        yield* close(notebook);
        return new StopCellResult({ before: "running", after: "killed" });
      });

      const stopNotebook: Interface["stopNotebook"] = Effect.fn("Notebook.stopNotebook")(
        function* (id) {
          const notebook = yield* getNotebook(id);
          const state = yield* Ref.get(notebook.status);
          if (state.status === "closed")
            return new StopNotebookResult({ before: "closed", after: "closed" });
          const live = yield* resources(notebook);
          if (state.status === "busy") {
            const active = yield* Effect.fromOption(() =>
              runtimeFailure("stop notebook", "Busy notebook has no active cell"),
            )(state.activeCellId);
            const cell = yield* getCell(active);
            if (!(yield* Deferred.isDone(cell.terminal)) && Option.isNone(yield* interrupt(cell, live)))
              yield* pipe(
                finish(
                  notebook,
                  cell,
                  new Terminal({
                    status: "interrupted",
                    completedAt: yield* now,
                    message: Option.none(),
                  }),
                ),
                recoverStorage(notebook, cell),
              );
          }
          yield* close(notebook);
          return new StopNotebookResult({ before: state.status, after: "closed" });
        },
      );

      const list: Interface["list"] = (
        input = new ListInput({ name: Option.none(), status: Option.none() }),
      ) => {
        const normalizedName = Option.map(input.name, (name) => name.toLowerCase());
        return pipe(
          Ref.get(registry),
          Effect.flatMap((state) =>
            Effect.forEach(HashMap.values(state.notebooks), summary),
          ),
          Effect.map(Chunk.fromIterable),
          Effect.map(
            Chunk.filter((notebook) =>
              Option.match(normalizedName, {
                onNone: () => true,
                onSome: (name) => notebook.name.toLowerCase().includes(name),
              }) &&
              Option.match(input.status, {
                onNone: () => true,
                onSome: (status) => notebook.status === status,
              }),
            ),
          ),
        );
      };

      yield* Effect.addFinalizer(() =>
        pipe(
          Ref.get(registry),
          Effect.flatMap((state) =>
            Effect.forEach(HashMap.keys(state.notebooks), stopNotebook, {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
          Effect.ignore,
        ),
      );

      return Service.of({ create, start, wait, stopCell, stopNotebook, list });
    }),
  );

export * from "./types.ts";
export * as Notebook from "./index.ts";
