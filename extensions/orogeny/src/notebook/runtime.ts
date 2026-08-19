import {
  Cause,
  Chunk,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  HashMap,
  Layer,
  Match,
  Option,
  pipe,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { messageFrom } from "#o/error";
import { Kernel } from "#o/jupyter/kernel";
import { Journal } from "#o/notebook/journal";
import {
  CellSnapshot,
  CellStatus,
  CreateInput,
  type NotebookCloseReason,
  NotebookStatus,
  NotebookSummary,
  StartInput,
  WaitInput,
} from "#o/notebook/model";
import {
  CellId,
  type CellId as CellIdType,
  NotebookId,
  type NotebookId as NotebookIdType,
} from "#o/notebook/schema";

const makeNotebookId = Schema.decodeUnknownSync(NotebookId);
const makeCellId = Schema.decodeUnknownSync(CellId);

export class Config extends Data.Class<{
  readonly artifactRoot: string;
  readonly maxLiveNotebooks: number;
  readonly maxWaitMillis: number;
  readonly interruptGraceMillis: number;
}> {}

export class OperationFailed extends Data.TaggedError(
  "NotebookRuntimeOperationFailed",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export type Interface = Readonly<{
  create: (
    input?: CreateInput,
  ) => Effect.Effect<NotebookSummary, OperationFailed>;
  start: (input: StartInput) => Effect.Effect<CellIdType, OperationFailed>;
  wait: (input: WaitInput) => Effect.Effect<CellSnapshot, OperationFailed>;
  stopCell: (id: CellIdType) => Effect.Effect<void, OperationFailed>;
  stopNotebook: (id: NotebookIdType) => Effect.Effect<void, OperationFailed>;
  list: Effect.Effect<Chunk.Chunk<NotebookSummary>, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "orogeny/Notebook.Runtime",
) {}

class LiveResources extends Data.Class<{
  readonly kernel: Kernel.Handle;
  readonly scope: Scope.Closeable;
}> {}

class NotebookEntry extends Data.Class<{
  readonly id: NotebookIdType;
  readonly name: Option.Option<string>;
  readonly artifact: Journal.Artifact;
  readonly createdAt: string;
  readonly status: Ref.Ref<NotebookStatus>;
  readonly resources: Option.Option<LiveResources>;
  readonly admission: Semaphore.Semaphore;
}> {}

class CellEntry extends Data.Class<{
  readonly id: CellIdType;
  readonly notebookId: NotebookIdType;
  readonly code: string;
  readonly startedAt: string;
  readonly status: Ref.Ref<CellStatus>;
  readonly outputs: Ref.Ref<Chunk.Chunk<Kernel.Output>>;
  readonly outputIndex: Ref.Ref<number>;
  readonly terminal: Deferred.Deferred<CellStatus>;
  readonly interruptRequested: Ref.Ref<boolean>;
  readonly completionLock: Semaphore.Semaphore;
}> {}

class Registry extends Data.Class<{
  readonly notebooks: HashMap.HashMap<NotebookIdType, NotebookEntry>;
  readonly cells: HashMap.HashMap<CellIdType, CellEntry>;
  readonly currentNotebookId: Option.Option<NotebookIdType>;
}> {}

const now = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis).toISOString()),
);

const runtimeFailure = (operation: string, cause: unknown) =>
  new OperationFailed({ operation, message: messageFrom(cause) });

export const layer = (config: Config) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const rootScope = yield* Effect.scope;
      const kernels = yield* Kernel.Service;
      const journal = yield* Journal.Service;
      const registry = yield* Ref.make(
        new Registry({
          notebooks: HashMap.empty(),
          cells: HashMap.empty(),
          currentNotebookId: Option.none(),
        }),
      );
      const liveCount = yield* Ref.make(0);
      const creationLock = yield* Semaphore.make(1);

      const getNotebook = Effect.fn("Notebook.Runtime.__getNotebook")(
        function* (id: NotebookIdType) {
          return yield* pipe(
            Ref.get(registry),
            Effect.map((current) => HashMap.get(current.notebooks, id)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new OperationFailed({
                      operation: "find notebook",
                      message: `Unknown notebook ID: ${id}`,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
        },
      );

      const getCell = Effect.fn("Notebook.Runtime.__getCell")(function* (
        id: CellIdType,
      ) {
        return yield* pipe(
          Ref.get(registry),
          Effect.map((current) => HashMap.get(current.cells, id)),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new OperationFailed({
                    operation: "find cell",
                    message: `Unknown cell ID: ${id}`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
      });

      const getResources = Effect.fn("Notebook.Runtime.__getResources")(
        function* (notebook: NotebookEntry) {
          return yield* Option.match(notebook.resources, {
            onNone: () =>
              Effect.fail(
                new OperationFailed({
                  operation: "use notebook kernel",
                  message: `Notebook ${notebook.id} has no live kernel`,
                }),
              ),
            onSome: Effect.succeed,
          });
        },
      );

      const notebookSummary = Effect.fn("Notebook.Runtime.__notebookSummary")(
        function* (notebook: NotebookEntry) {
          const state = yield* Ref.get(notebook.status);
          const current = (yield* Ref.get(registry)).currentNotebookId;
          return NotebookStatus.$match(state, {
            idle: (value) =>
              new NotebookSummary({
                id: notebook.id,
                name: notebook.name,
                status: "idle",
                current: Option.contains(current, notebook.id),
                artifactPath: notebook.artifact.directory,
                activeCellId: Option.none(),
                createdAt: notebook.createdAt,
                updatedAt: value.updatedAt,
                closeReason: Option.none(),
              }),
            busy: (value) =>
              new NotebookSummary({
                id: notebook.id,
                name: notebook.name,
                status: "busy",
                current: Option.contains(current, notebook.id),
                artifactPath: notebook.artifact.directory,
                activeCellId: Option.some(value.activeCellId),
                createdAt: notebook.createdAt,
                updatedAt: value.updatedAt,
                closeReason: Option.none(),
              }),
            closed: (value) =>
              new NotebookSummary({
                id: notebook.id,
                name: notebook.name,
                status: "closed",
                current: Option.contains(current, notebook.id),
                artifactPath: notebook.artifact.directory,
                activeCellId: Option.none(),
                createdAt: notebook.createdAt,
                updatedAt: value.updatedAt,
                closeReason: Option.some(value.reason),
              }),
          });
        },
      );

      const cellSnapshot = Effect.fn("Notebook.Runtime.__cellSnapshot")(
        function* (cell: CellEntry) {
          const status = yield* Ref.get(cell.status);
          const outputs = yield* Ref.get(cell.outputs);
          return CellStatus.$match(status, {
            running: () =>
              new CellSnapshot({
                id: cell.id,
                notebookId: cell.notebookId,
                status: "running",
                outputs,
                startedAt: cell.startedAt,
                completedAt: Option.none(),
                message: Option.none(),
              }),
            succeeded: (value) =>
              new CellSnapshot({
                id: cell.id,
                notebookId: cell.notebookId,
                status: "succeeded",
                outputs,
                startedAt: cell.startedAt,
                completedAt: Option.some(value.completedAt),
                message: Option.none(),
              }),
            failed: (value) =>
              new CellSnapshot({
                id: cell.id,
                notebookId: cell.notebookId,
                status: "failed",
                outputs,
                startedAt: cell.startedAt,
                completedAt: Option.some(value.completedAt),
                message: value.message,
              }),
            interrupted: (value) =>
              new CellSnapshot({
                id: cell.id,
                notebookId: cell.notebookId,
                status: "interrupted",
                outputs,
                startedAt: cell.startedAt,
                completedAt: Option.some(value.completedAt),
                message: Option.none(),
              }),
          });
        },
      );

      const setNotebookIdle = Effect.fn("Notebook.Runtime.__setNotebookIdle")(
        function* (
          notebook: NotebookEntry,
          cellId: CellIdType,
          timestamp: string,
        ) {
          yield* Ref.update(
            notebook.status,
            NotebookStatus.$match({
              idle: (state) => state,
              busy: (state) =>
                state.activeCellId === cellId
                  ? NotebookStatus.idle({ updatedAt: timestamp })
                  : state,
              closed: (state) => state,
            }),
          );
        },
      );

      const finishInMemory = Effect.fn("Notebook.Runtime.__finishInMemory")(
        function* (
          notebook: NotebookEntry,
          cell: CellEntry,
          status: CellStatus,
        ) {
          yield* cell.completionLock.withPermit(
            Effect.gen(function* () {
              if (!CellStatus.$is("running")(yield* Ref.get(cell.status)))
                return;
              yield* Ref.set(cell.status, status);
              const timestamp = CellStatus.$match(status, {
                running: (value) => value.startedAt,
                succeeded: (value) => value.completedAt,
                failed: (value) => value.completedAt,
                interrupted: (value) => value.completedAt,
              });
              yield* setNotebookIdle(notebook, cell.id, timestamp);
              yield* Deferred.succeed(cell.terminal, status);
            }),
          );
        },
      );

      const finishCell = Effect.fn("Notebook.Runtime.__finishCell")(function* (
        notebook: NotebookEntry,
        cell: CellEntry,
        status: CellStatus,
      ) {
        yield* cell.completionLock.withPermit(
          Effect.gen(function* () {
            if (!CellStatus.$is("running")(yield* Ref.get(cell.status))) return;
            const record = CellStatus.$match(status, {
              running: () =>
                Journal.Entry.cellCompleted({
                  cellId: cell.id,
                  status: "failed",
                  message: Option.some("Invalid running terminal state"),
                }),
              succeeded: () =>
                Journal.Entry.cellCompleted({
                  cellId: cell.id,
                  status: "succeeded",
                  message: Option.none(),
                }),
              failed: (value) =>
                Journal.Entry.cellCompleted({
                  cellId: cell.id,
                  status: "failed",
                  message: value.message,
                }),
              interrupted: () =>
                Journal.Entry.cellCompleted({
                  cellId: cell.id,
                  status: "interrupted",
                  message: Option.none(),
                }),
            });
            yield* journal.append(notebook.artifact, record);
            yield* Ref.set(cell.status, status);
            const timestamp = CellStatus.$match(status, {
              running: (value) => value.startedAt,
              succeeded: (value) => value.completedAt,
              failed: (value) => value.completedAt,
              interrupted: (value) => value.completedAt,
            });
            yield* setNotebookIdle(notebook, cell.id, timestamp);
            yield* Deferred.succeed(cell.terminal, status);
          }),
        );
      });

      const closeResources = Effect.fn("Notebook.Runtime.__closeResources")(
        function* (notebook: NotebookEntry) {
          yield* Option.match(notebook.resources, {
            onNone: () => Effect.void,
            onSome: (resources) =>
              pipe(
                resources.kernel.shutdown,
                Effect.ignore,
                Effect.andThen(Scope.close(resources.scope, Exit.void)),
                Effect.ignore,
              ),
          });
        },
      );

      const closeNotebook = Effect.fn("Notebook.Runtime.__closeNotebook")(
        function* (
          notebook: NotebookEntry,
          reason: NotebookCloseReason,
          persist: boolean,
        ) {
          yield* notebook.admission.withPermit(
            Effect.gen(function* () {
              const timestamp = yield* now;
              const changed = yield* Ref.modify(notebook.status, (current) =>
                NotebookStatus.$match(current, {
                  idle: () =>
                    [
                      true,
                      NotebookStatus.closed({ reason, updatedAt: timestamp }),
                    ] as const,
                  busy: () =>
                    [
                      true,
                      NotebookStatus.closed({ reason, updatedAt: timestamp }),
                    ] as const,
                  closed: (state) => [false, state] as const,
                }),
              );
              if (!changed) return;
              yield* Ref.update(liveCount, (count) => Math.max(0, count - 1));
              if (persist) {
                yield* journal
                  .append(
                    notebook.artifact,
                    Journal.Entry.notebookClosed({ reason }),
                  )
                  .pipe(Effect.ensuring(closeResources(notebook)));
                return;
              }
              yield* closeResources(notebook);
            }),
          );
        },
      );

      const storageFailure = Effect.fn("Notebook.Runtime.__storageFailure")(
        function* (
          notebook: NotebookEntry,
          cell: CellEntry,
          cause: Journal.OperationFailed,
        ) {
          const completedAt = yield* now;
          yield* finishInMemory(
            notebook,
            cell,
            CellStatus.failed({
              completedAt,
              message: Option.some(cause.message),
            }),
          );
          yield* closeNotebook(notebook, "storage_failure", false).pipe(
            Effect.ignore,
          );
        },
      );

      const crashFailure = Effect.fn("Notebook.Runtime.__crashFailure")(
        function* (
          notebook: NotebookEntry,
          cell: CellEntry,
          cause: Kernel.OperationFailed,
        ) {
          const completedAt = yield* now;
          yield* pipe(
            finishCell(
              notebook,
              cell,
              CellStatus.failed({
                completedAt,
                message: Option.some(cause.message),
              }),
            ),
            Effect.catchTag("NotebookJournalOperationFailed", (failure) =>
              storageFailure(notebook, cell, failure),
            ),
          );
          yield* closeNotebook(notebook, "crashed", true).pipe(
            Effect.catchTag("NotebookJournalOperationFailed", (failure) =>
              storageFailure(notebook, cell, failure),
            ),
          );
        },
      );

      const appendOutput = Effect.fn("Notebook.Runtime.__appendOutput")(
        function* (
          notebook: NotebookEntry,
          cell: CellEntry,
          output: Kernel.Output,
        ) {
          const outputIndex = yield* Ref.getAndUpdate(
            cell.outputIndex,
            (current) => current + 1,
          );
          yield* journal.append(
            notebook.artifact,
            Journal.Entry.cellOutput({
              cellId: cell.id,
              outputIndex,
              output,
            }),
          );
          yield* Ref.update(cell.outputs, Chunk.append(output));
        },
      );

      const runCell = Effect.fn("Notebook.Runtime.__runCell")(function* (
        notebook: NotebookEntry,
        cell: CellEntry,
        execution: Kernel.Execution,
      ) {
        const run = pipe(
          Effect.all(
            {
              result: execution.completion,
              outputs: pipe(
                execution.outputs,
                Stream.runForEach((output) =>
                  appendOutput(notebook, cell, output),
                ),
              ),
            },
            { concurrency: "unbounded" },
          ),
          Effect.flatMap(({ result }) =>
            Effect.gen(function* () {
              const completedAt = yield* now;
              const interrupted = yield* Ref.get(cell.interruptRequested);
              const terminal = pipe(
                Match.value(result.status),
                Match.when("succeeded", () =>
                  CellStatus.succeeded({ completedAt }),
                ),
                Match.orElse(() =>
                  interrupted
                    ? CellStatus.interrupted({ completedAt })
                    : CellStatus.failed({
                        completedAt,
                        message: Option.fromUndefinedOr(result.reply.evalue),
                      }),
                ),
              );
              yield* finishCell(notebook, cell, terminal);
            }),
          ),
          Effect.catchTags({
            NotebookJournalOperationFailed: (cause) =>
              storageFailure(notebook, cell, cause),
            JupyterKernelOperationFailed: (cause) =>
              crashFailure(notebook, cell, cause),
          }),
        );
        yield* run;
      });

      const resolveNotebook = Effect.fn("Notebook.Runtime.__resolveNotebook")(
        function* (requested: Option.Option<NotebookIdType>) {
          const current = yield* Ref.get(registry);
          const id = yield* Option.match(requested, {
            onNone: () =>
              Option.match(current.currentNotebookId, {
                onNone: () =>
                  Effect.fail(
                    new OperationFailed({
                      operation: "resolve current notebook",
                      message: "No current notebook is selected",
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            onSome: Effect.succeed,
          });
          return yield* getNotebook(id);
        },
      );

      const create: Interface["create"] = Effect.fn("Notebook.Runtime.create")(
        function* (input = CreateInput.unnamed) {
          return yield* creationLock.withPermit(
            Effect.gen(function* () {
              const count = yield* Ref.get(liveCount);
              if (count >= config.maxLiveNotebooks) {
                return yield* new OperationFailed({
                  operation: "create notebook",
                  message: `The live notebook limit of ${config.maxLiveNotebooks} has been reached`,
                });
              }

              const id = makeNotebookId(`nb_${globalThis.crypto.randomUUID()}`);
              const createdAt = yield* now;
              const artifact = yield* journal
                .create(config.artifactRoot, id, input.name)
                .pipe(
                  Effect.mapError((cause) =>
                    runtimeFailure("create notebook artifact", cause),
                  ),
                );
              const childScope = yield* Scope.fork(rootScope);
              const opened = yield* pipe(
                kernels.open(),
                Scope.provide(childScope),
                Effect.exit,
              );

              return yield* Exit.match(opened, {
                onFailure: (cause) =>
                  Effect.gen(function* () {
                    const timestamp = yield* now;
                    const notebook = new NotebookEntry({
                      id,
                      name: input.name,
                      artifact,
                      createdAt,
                      status: yield* Ref.make<NotebookStatus>(
                        NotebookStatus.closed({
                          reason: "startup_failed",
                          updatedAt: timestamp,
                        }),
                      ),
                      resources: Option.none(),
                      admission: yield* Semaphore.make(1),
                    });
                    yield* Ref.update(
                      registry,
                      (current) =>
                        new Registry({
                          ...current,
                          notebooks: HashMap.set(
                            current.notebooks,
                            id,
                            notebook,
                          ),
                        }),
                    );
                    yield* journal
                      .append(
                        artifact,
                        Journal.Entry.notebookClosed({
                          reason: "startup_failed",
                        }),
                      )
                      .pipe(Effect.ignore);
                    yield* Scope.close(childScope, Exit.void);
                    return yield* new OperationFailed({
                      operation: "start notebook kernel",
                      message: `${Cause.pretty(cause)}\nNotebook: ${id}\nArtifact: ${artifact.directory}`,
                    });
                  }),
                onSuccess: (kernel) =>
                  Effect.gen(function* () {
                    const notebook = new NotebookEntry({
                      id,
                      name: input.name,
                      artifact,
                      createdAt,
                      status: yield* Ref.make<NotebookStatus>(
                        NotebookStatus.idle({ updatedAt: createdAt }),
                      ),
                      resources: Option.some(
                        new LiveResources({ kernel, scope: childScope }),
                      ),
                      admission: yield* Semaphore.make(1),
                    });
                    yield* Ref.update(
                      registry,
                      (current) =>
                        new Registry({
                          ...current,
                          notebooks: HashMap.set(
                            current.notebooks,
                            id,
                            notebook,
                          ),
                          currentNotebookId: Option.some(id),
                        }),
                    );
                    yield* Ref.update(liveCount, (current) => current + 1);
                    return yield* notebookSummary(notebook);
                  }),
              });
            }),
          );
        },
      );

      const start: Interface["start"] = Effect.fn("Notebook.Runtime.start")(
        function* (input) {
          const notebook = yield* resolveNotebook(input.notebookId);
          const resources = yield* getResources(notebook);
          const cell = yield* notebook.admission.withPermit(
            Effect.gen(function* () {
              const state = yield* Ref.get(notebook.status);
              yield* NotebookStatus.$match(state, {
                idle: () => Effect.void,
                busy: (value) =>
                  Effect.fail(
                    new OperationFailed({
                      operation: "start notebook cell",
                      message: `Notebook ${notebook.id} is busy with ${value.activeCellId}`,
                    }),
                  ),
                closed: (value) =>
                  Effect.fail(
                    new OperationFailed({
                      operation: "start notebook cell",
                      message: `Notebook ${notebook.id} is closed (${value.reason})`,
                    }),
                  ),
              });

              const id = makeCellId(`cell_${globalThis.crypto.randomUUID()}`);
              const startedAt = yield* now;
              const cell = new CellEntry({
                id,
                notebookId: notebook.id,
                code: input.code,
                startedAt,
                status: yield* Ref.make<CellStatus>(
                  CellStatus.running({ startedAt }),
                ),
                outputs: yield* Ref.make<Chunk.Chunk<Kernel.Output>>(
                  Chunk.empty(),
                ),
                outputIndex: yield* Ref.make(0),
                terminal: yield* Deferred.make<CellStatus>(),
                interruptRequested: yield* Ref.make(false),
                completionLock: yield* Semaphore.make(1),
              });
              yield* Ref.set(
                notebook.status,
                NotebookStatus.busy({
                  activeCellId: id,
                  updatedAt: startedAt,
                }),
              );
              yield* Ref.update(
                registry,
                (current) =>
                  new Registry({
                    ...current,
                    cells: HashMap.set(current.cells, id, cell),
                    currentNotebookId: Option.some(notebook.id),
                  }),
              );
              return cell;
            }),
          );

          yield* journal
            .append(
              notebook.artifact,
              Journal.Entry.cellStarted({
                cellId: cell.id,
                code: input.code,
              }),
            )
            .pipe(
              Effect.catchTag("NotebookJournalOperationFailed", (cause) =>
                pipe(
                  storageFailure(notebook, cell, cause),
                  Effect.andThen(
                    Effect.fail(runtimeFailure("journal notebook cell", cause)),
                  ),
                ),
              ),
            );

          const execution = yield* resources.kernel
            .start(input.code)
            .pipe(
              Effect.catch((cause) =>
                pipe(
                  crashFailure(notebook, cell, cause),
                  Effect.andThen(
                    Effect.fail(runtimeFailure("submit notebook cell", cause)),
                  ),
                ),
              ),
            );
          yield* pipe(
            runCell(notebook, cell, execution),
            Effect.forkIn(resources.scope),
          );
          return cell.id;
        },
      );

      const wait: Interface["wait"] = Effect.fn("Notebook.Runtime.wait")(
        function* (input) {
          const cell = yield* getCell(input.cellId);
          const status = yield* Ref.get(cell.status);
          if (CellStatus.$is("running")(status) && input.timeoutMillis > 0) {
            yield* pipe(
              Deferred.await(cell.terminal),
              Effect.timeoutOption(
                Math.min(input.timeoutMillis, config.maxWaitMillis),
              ),
              Effect.asVoid,
            );
          }
          return yield* cellSnapshot(cell);
        },
      );

      const stopCell: Interface["stopCell"] = Effect.fn(
        "Notebook.Runtime.stopCell",
      )(function* (id) {
        const cell = yield* getCell(id);
        if (!CellStatus.$is("running")(yield* Ref.get(cell.status))) return;
        const notebook = yield* getNotebook(cell.notebookId);
        const resources = yield* getResources(notebook);
        yield* Ref.set(cell.interruptRequested, true);
        const requested = yield* pipe(
          resources.kernel.interrupt,
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        const settled = requested
          ? yield* Deferred.await(cell.terminal).pipe(
              Effect.timeoutOption(config.interruptGraceMillis),
            )
          : Option.none();
        if (Option.isSome(settled)) return;

        const completedAt = yield* now;
        yield* finishCell(
          notebook,
          cell,
          CellStatus.interrupted({ completedAt }),
        ).pipe(
          Effect.catchTag("NotebookJournalOperationFailed", (cause) =>
            storageFailure(notebook, cell, cause),
          ),
        );
        yield* closeNotebook(notebook, "unresponsive", true).pipe(
          Effect.catchTag("NotebookJournalOperationFailed", (cause) =>
            storageFailure(notebook, cell, cause),
          ),
        );
      });

      const stopNotebook: Interface["stopNotebook"] = Effect.fn(
        "Notebook.Runtime.stopNotebook",
      )(function* (id) {
        const notebook = yield* getNotebook(id);
        const state = yield* Ref.get(notebook.status);
        if (NotebookStatus.$is("closed")(state)) return;
        const resources = yield* getResources(notebook);
        yield* NotebookStatus.$match(state, {
          idle: () => Effect.void,
          closed: () => Effect.void,
          busy: (value) =>
            Effect.gen(function* () {
              const cell = yield* getCell(value.activeCellId);
              if (!CellStatus.$is("running")(yield* Ref.get(cell.status)))
                return;
              yield* Ref.set(cell.interruptRequested, true);
              yield* resources.kernel.interrupt.pipe(Effect.ignore);
              yield* Deferred.await(cell.terminal).pipe(
                Effect.timeoutOption(config.interruptGraceMillis),
              );
              if (!CellStatus.$is("running")(yield* Ref.get(cell.status)))
                return;
              const completedAt = yield* now;
              yield* finishCell(
                notebook,
                cell,
                CellStatus.interrupted({ completedAt }),
              ).pipe(
                Effect.catchTag("NotebookJournalOperationFailed", (cause) =>
                  storageFailure(notebook, cell, cause),
                ),
              );
            }),
        });
        yield* closeNotebook(notebook, "manual", true).pipe(
          Effect.mapError((cause) =>
            runtimeFailure("close notebook journal", cause),
          ),
        );
      });

      const list: Interface["list"] = pipe(
        Ref.get(registry),
        Effect.flatMap((current) =>
          Effect.forEach(HashMap.values(current.notebooks), notebookSummary),
        ),
        Effect.map(Chunk.fromIterable),
      );

      yield* Effect.addFinalizer(() =>
        pipe(
          Ref.get(registry),
          Effect.flatMap((current) =>
            Effect.forEach(HashMap.keys(current.notebooks), stopNotebook, {
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

export * as Runtime from "./runtime.ts";
