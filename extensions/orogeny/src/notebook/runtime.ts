import {
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
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import * as Kernel from "#o/jupyter/kernel";

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const NotebookId = Schema.String.check(
  Schema.isPattern(new RegExp(`^nb_${UUID}$`)),
).pipe(Schema.brand("NotebookId"));
export type NotebookId = typeof NotebookId.Type;
export const CellId = Schema.String.check(
  Schema.isPattern(new RegExp(`^cell_${UUID}$`)),
).pipe(Schema.brand("CellId"));
export type CellId = typeof CellId.Type;
const notebookId = Schema.decodeUnknownSync(NotebookId);
const cellId = Schema.decodeUnknownSync(CellId);
export type NotebookCloseReason =
  "manual" | "crashed" | "startup_failed" | "storage_failure" | "unresponsive";
class NotebookState extends Data.Class<{
  readonly status: "idle" | "busy" | "closed";
  readonly activeCellId: Option.Option<CellId>;
  readonly closeReason: Option.Option<NotebookCloseReason>;
  readonly updatedAt: string;
}> {}
class Terminal extends Data.Class<{
  readonly status: "succeeded" | "failed" | "interrupted";
  readonly completedAt: string;
  readonly message: Option.Option<string>;
}> {}

export class Config extends Data.Class<{
  readonly artifactRoot: string;
  readonly maxLiveNotebooks: number;
  readonly maxWaitMillis: number;
  readonly interruptGraceMillis: number;
}> {}
export class CreateInput extends Data.Class<{
  readonly name: Option.Option<string>;
}> {}
export class StartInput extends Data.Class<{
  readonly code: string;
  readonly notebookId: Option.Option<NotebookId>;
}> {}
export class WaitInput extends Data.Class<{
  readonly cellId: CellId;
  readonly timeoutMillis: number;
}> {}
export class NotebookSummary extends Data.Class<{
  readonly id: NotebookId;
  readonly name: Option.Option<string>;
  readonly status: "idle" | "busy" | "closed";
  readonly current: boolean;
  readonly artifactPath: string;
  readonly activeCellId: Option.Option<CellId>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closeReason: Option.Option<NotebookCloseReason>;
}> {}
export class CellSnapshot extends Data.Class<{
  readonly id: CellId;
  readonly notebookId: NotebookId;
  readonly status: "running" | "succeeded" | "failed" | "interrupted";
  readonly outputs: Chunk.Chunk<Kernel.Output>;
  readonly startedAt: string;
  readonly completedAt: Option.Option<string>;
  readonly message: Option.Option<string>;
}> {}
type FailureData = { readonly operation: string; readonly message: string };
export class OperationFailed extends Data.TaggedError(
  "Notebook",
)<FailureData> {}
class JournalFailed extends Data.TaggedError("NotebookJournalOperationFailed")<{
  readonly message: string;
}> {}

export type Interface = Readonly<{
  create: (
    input?: CreateInput,
  ) => Effect.Effect<NotebookSummary, OperationFailed>;
  start: (input: StartInput) => Effect.Effect<CellId, OperationFailed>;
  wait: (input: WaitInput) => Effect.Effect<CellSnapshot, OperationFailed>;
  stopCell: (id: CellId) => Effect.Effect<void, OperationFailed>;
  stopNotebook: (id: NotebookId) => Effect.Effect<void, OperationFailed>;
  list: Effect.Effect<Chunk.Chunk<NotebookSummary>, OperationFailed>;
}>;
export class Service extends Context.Service<Service, Interface>()(
  "orogeny/Notebook.Runtime",
) {}

class Resources extends Data.Class<{
  readonly kernel: Kernel.Handle;
  readonly scope: Scope.Closeable;
}> {}
class Artifact extends Data.Class<{
  readonly directory: string;
  readonly path: string;
  readonly sequence: SynchronizedRef.SynchronizedRef<number>;
}> {}
class Notebook extends Data.Class<{
  readonly id: NotebookId;
  readonly name: Option.Option<string>;
  readonly artifact: Artifact;
  readonly createdAt: string;
  readonly status: Ref.Ref<NotebookState>;
  readonly resources: Option.Option<Resources>;
  readonly admission: Semaphore.Semaphore;
}> {}
class Cell extends Data.Class<{
  readonly id: CellId;
  readonly notebookId: NotebookId;
  readonly startedAt: string;
  readonly outputs: Ref.Ref<Chunk.Chunk<Kernel.Output>>;
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
const JsonLine = Schema.fromJsonString(Schema.Json);
const now = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis).toISOString()),
);
const runtimeFailure = (operation: string, cause: unknown) =>
  new OperationFailed({ operation, message: String(cause) });
const outputJson = (output: Kernel.Output): Schema.Json =>
  Kernel.Output.$match(output, {
    stream: (value) => ({ type: "stream", ...value }),
    display: (value) => ({
      type: "display",
      kind: value.kind,
      data: value.data,
      metadata: value.metadata,
      transient: Option.getOrNull(value.transient),
    }),
    error: (value) => ({
      type: "error",
      name: value.name,
      value: value.value,
      traceback: Chunk.toReadonlyArray(value.traceback),
    }),
    clear: (value) => ({ type: "clear", ...value }),
  });

export const layer = (config: Config) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const rootScope = yield* Effect.scope;
      const kernels = yield* Kernel.Service;
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
          }).pipe(journalError),
        );
      const createArtifact = Effect.fn("Notebook.artifact")(function* (
        id: NotebookId,
        name: Option.Option<string>,
      ) {
        const directory = paths.join(config.artifactRoot, id);
        const path = paths.join(directory, "notebook.jsonl");
        yield* pipe(
          files.makeDirectory(config.artifactRoot, {
            recursive: true,
            mode: 0o700,
          }),
          Effect.andThen(files.makeDirectory(directory, { mode: 0o700 })),
          Effect.andThen(
            files.writeFileString(path, "", { flag: "wx", mode: 0o600 }),
          ),
          journalError,
        );
        const artifact = new Artifact({
          directory,
          path,
          sequence: yield* SynchronizedRef.make(0),
        });
        yield* append(artifact, {
          event: "notebook_created",
          name: Option.getOrNull(name),
        });
        return artifact;
      });
      const getNotebook = (id: NotebookId) =>
        Ref.get(registry).pipe(
          Effect.flatMap((state) =>
            Effect.fromOption(() =>
              runtimeFailure("find notebook", `Unknown notebook ID: ${id}`),
            )(HashMap.get(state.notebooks, id)),
          ),
        );
      const getCell = (id: CellId) =>
        Ref.get(registry).pipe(
          Effect.flatMap((state) =>
            Effect.fromOption(() =>
              runtimeFailure("find cell", `Unknown cell ID: ${id}`),
            )(HashMap.get(state.cells, id)),
          ),
        );
      const resources = (notebook: Notebook) =>
        Effect.fromOption(() =>
          runtimeFailure(
            "use notebook kernel",
            `Notebook ${notebook.id} is closed`,
          ),
        )(notebook.resources);
      const summary = Effect.fn("Notebook.summary")(function* (
        notebook: Notebook,
      ) {
        const state = yield* Ref.get(notebook.status);
        return new NotebookSummary({
          id: notebook.id,
          name: notebook.name,
          current: Option.contains(
            (yield* Ref.get(registry)).current,
            notebook.id,
          ),
          artifactPath: notebook.artifact.directory,
          createdAt: notebook.createdAt,
          ...state,
        });
      });
      const snapshot = Effect.fn("Notebook.snapshot")(function* (cell: Cell) {
        const terminal = (yield* Deferred.isDone(cell.terminal))
          ? Option.some(yield* Deferred.await(cell.terminal))
          : Option.none<Terminal>();
        const details = Option.match(terminal, {
          onNone: () => ({
            status: "running" as const,
            completedAt: Option.none<string>(),
            message: Option.none<string>(),
          }),
          onSome: (value) => ({
            status: value.status,
            completedAt: Option.some(value.completedAt),
            message: value.message,
          }),
        });
        return new CellSnapshot({
          id: cell.id,
          notebookId: cell.notebookId,
          outputs: yield* Ref.get(cell.outputs),
          startedAt: cell.startedAt,
          ...details,
        });
      });
      const idleNotebook = (
        notebook: Notebook,
        id: CellId,
        updatedAt: string,
      ) =>
        Ref.update(notebook.status, (state) =>
          state.status === "busy" && Option.contains(state.activeCellId, id)
            ? new NotebookState({
                status: "idle",
                activeCellId: Option.none(),
                closeReason: Option.none(),
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
      const transitionClosed = <E, R>(
        notebook: Notebook,
        reason: NotebookCloseReason,
        before: Effect.Effect<void, E, R>,
      ): Effect.Effect<void, E, R> =>
        notebook.admission.withPermit(
          Effect.gen(function* () {
            if ((yield* Ref.get(notebook.status)).status === "closed") return;
            yield* Effect.gen(function* () {
              yield* before;
              yield* Ref.set(
                notebook.status,
                new NotebookState({
                  status: "closed",
                  activeCellId: Option.none(),
                  closeReason: Option.some(reason),
                  updatedAt: yield* now,
                }),
              );
              yield* Ref.update(
                registry,
                (state) => new Registry({ ...state, live: state.live - 1 }),
              );
            }).pipe(Effect.ensuring(closeResources(notebook)));
          }),
        );
      const close = (notebook: Notebook, reason: NotebookCloseReason) =>
        transitionClosed(
          notebook,
          reason,
          append(notebook.artifact, { event: "notebook_closed", reason }),
        );
      const storageFailure = Effect.fn("Notebook.storageFailure")(function* (
        notebook: Notebook,
        cell: Cell,
        cause: JournalFailed,
      ) {
        yield* complete(
          notebook,
          cell,
          new Terminal({
            status: "failed",
            completedAt: yield* now,
            message: Option.some(cause.message),
          }),
          Effect.void,
        );
        yield* transitionClosed(notebook, "storage_failure", Effect.void).pipe(
          Effect.ignore,
        );
      });
      const recoverStorage =
        (notebook: Notebook, cell: Cell) =>
        <A, R>(self: Effect.Effect<A, JournalFailed, R>) =>
          self.pipe(
            Effect.catchTag("NotebookJournalOperationFailed", (cause) =>
              storageFailure(notebook, cell, cause),
            ),
          );
      const crashFailure = Effect.fn("Notebook.crashFailure")(function* (
        notebook: Notebook,
        cell: Cell,
        cause: Kernel.OperationFailed,
      ) {
        yield* finish(
          notebook,
          cell,
          new Terminal({
            status: "failed",
            completedAt: yield* now,
            message: Option.some(cause.message),
          }),
        ).pipe(recoverStorage(notebook, cell));
        yield* close(notebook, "crashed").pipe(recoverStorage(notebook, cell));
      });
      const appendOutput = (
        notebook: Notebook,
        cell: Cell,
        outputIndex: number,
        output: Kernel.Output,
      ) =>
        append(notebook.artifact, {
          event: "cell_output",
          cell_id: cell.id,
          output_index: outputIndex,
          output: outputJson(output),
        }).pipe(
          Effect.andThen(
            Ref.update(cell.outputs, (outputs) =>
              Chunk.append(outputs, output),
            ),
          ),
        );
      const runCell = Effect.fn("Notebook.runCell")(function* (
        notebook: Notebook,
        cell: Cell,
        execution: Kernel.Execution,
      ) {
        yield* pipe(
          Effect.all(
            {
              result: execution.completion,
              output: pipe(
                execution.outputs,
                Stream.zipWithIndex,
                Stream.runForEach(([output, index]) =>
                  appendOutput(notebook, cell, index, output),
                ),
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
            NotebookJournalOperationFailed: (cause) =>
              storageFailure(notebook, cell, cause),
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
        name: Option.Option<string>,
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

      const create: Interface["create"] = Effect.fn("Notebook.create")(
        function* (input = new CreateInput({ name: Option.none() })) {
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
              const artifact = yield* createArtifact(id, input.name).pipe(
                Effect.mapError((cause) =>
                  runtimeFailure("create notebook artifact", cause),
                ),
              );
              const scope = yield* Scope.fork(rootScope);
              const opened = yield* kernels.open.pipe(
                Scope.provide(scope),
                Effect.exit,
              );
              if (Exit.isFailure(opened)) {
                const notebook = yield* makeNotebook(
                  id,
                  input.name,
                  artifact,
                  createdAt,
                  new NotebookState({
                    status: "closed",
                    activeCellId: Option.none(),
                    closeReason: Option.some("startup_failed"),
                    updatedAt: yield* now,
                  }),
                  Option.none(),
                );
                yield* Ref.update(
                  registry,
                  (value) =>
                    new Registry({
                      ...value,
                      notebooks: HashMap.set(value.notebooks, id, notebook),
                    }),
                );
                yield* append(artifact, {
                  event: "notebook_closed",
                  reason: "startup_failed",
                }).pipe(Effect.ignore);
                yield* Scope.close(scope, Exit.void);
                return yield* runtimeFailure(
                  "start notebook kernel",
                  `${Cause.pretty(opened.cause)}\nNotebook: ${id}\nArtifact: ${artifact.directory}`,
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
                  closeReason: Option.none(),
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
        },
      );
      const start: Interface["start"] = Effect.fn("Notebook.start")(
        function* (input) {
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
              const cell = new Cell({
                id,
                notebookId: notebook.id,
                startedAt,
                outputs: yield* Ref.make(Chunk.empty<Kernel.Output>()),
                interruptRequested: yield* Ref.make(false),
                terminal: yield* Deferred.make<Terminal>(),
                completion: yield* Semaphore.make(1),
              });
              yield* Ref.set(
                notebook.status,
                new NotebookState({
                  status: "busy",
                  activeCellId: Option.some(id),
                  closeReason: Option.none(),
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
          yield* append(notebook.artifact, {
            event: "cell_started",
            cell_id: cell.id,
            code: input.code,
          }).pipe(
            Effect.catchTag("NotebookJournalOperationFailed", (cause) =>
              storageFailure(notebook, cell, cause).pipe(
                Effect.andThen(
                  Effect.fail(runtimeFailure("journal notebook cell", cause)),
                ),
              ),
            ),
          );
          const execution = yield* live.kernel
            .start(input.code)
            .pipe(
              Effect.catch((cause) =>
                crashFailure(notebook, cell, cause).pipe(
                  Effect.andThen(
                    Effect.fail(runtimeFailure("submit notebook cell", cause)),
                  ),
                ),
              ),
            );
          yield* runCell(notebook, cell, execution).pipe(
            Effect.forkIn(live.scope),
          );
          return cell.id;
        },
      );
      const wait: Interface["wait"] = Effect.fn("Notebook.wait")(
        function* (input) {
          const cell = yield* getCell(input.cellId);
          if (
            !(yield* Deferred.isDone(cell.terminal)) &&
            input.timeoutMillis > 0
          )
            yield* Deferred.await(cell.terminal).pipe(
              Effect.timeoutOption(
                Math.min(input.timeoutMillis, config.maxWaitMillis),
              ),
            );
          return yield* snapshot(cell);
        },
      );
      const interrupt = Effect.fn("Notebook.interrupt")(function* (
        cell: Cell,
        live: Resources,
      ) {
        yield* Ref.set(cell.interruptRequested, true);
        const requested = yield* pipe(
          live.kernel.interrupt,
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        return (
          requested &&
          Option.isSome(
            yield* Deferred.await(cell.terminal).pipe(
              Effect.timeoutOption(config.interruptGraceMillis),
            ),
          )
        );
      });
      const stopCell: Interface["stopCell"] = Effect.fn("Notebook.stopCell")(
        function* (id) {
          const cell = yield* getCell(id);
          if (yield* Deferred.isDone(cell.terminal)) return;
          const notebook = yield* getNotebook(cell.notebookId);
          if (yield* interrupt(cell, yield* resources(notebook))) return;
          yield* finish(
            notebook,
            cell,
            new Terminal({
              status: "interrupted",
              completedAt: yield* now,
              message: Option.none(),
            }),
          ).pipe(recoverStorage(notebook, cell));
          yield* close(notebook, "unresponsive").pipe(
            recoverStorage(notebook, cell),
          );
        },
      );
      const stopNotebook: Interface["stopNotebook"] = Effect.fn(
        "Notebook.stopNotebook",
      )(function* (id) {
        const notebook = yield* getNotebook(id);
        const state = yield* Ref.get(notebook.status);
        if (state.status === "closed") return;
        const live = yield* resources(notebook);
        if (state.status === "busy") {
          const active = yield* Effect.fromOption(() =>
            runtimeFailure("stop notebook", "Busy notebook has no active cell"),
          )(state.activeCellId);
          const cell = yield* getCell(active);
          if (
            !(yield* Deferred.isDone(cell.terminal)) &&
            !(yield* interrupt(cell, live))
          )
            yield* finish(
              notebook,
              cell,
              new Terminal({
                status: "interrupted",
                completedAt: yield* now,
                message: Option.none(),
              }),
            ).pipe(recoverStorage(notebook, cell));
        }
        yield* close(notebook, "manual").pipe(
          Effect.mapError((cause) =>
            runtimeFailure("close notebook journal", cause),
          ),
        );
      });
      const list: Interface["list"] = pipe(
        Ref.get(registry),
        Effect.flatMap((state) =>
          Effect.forEach(HashMap.values(state.notebooks), summary),
        ),
        Effect.map(Chunk.fromIterable),
      );
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
