import {
  Chunk,
  Clock,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  pipe,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import { messageFrom } from "#o/error";
import { Kernel } from "#o/jupyter/kernel";
import { MimeBundle } from "#o/jupyter/schema";
import type { NotebookCloseReason } from "#o/notebook/model";
import type { CellId, NotebookId } from "#o/notebook/schema";
import { CellId as CellIdSchema } from "#o/notebook/schema";

const RecordFields = {
  sequence: Schema.Int,
  timestamp: Schema.String,
};

class StreamOutputRecord extends Schema.TaggedClass<StreamOutputRecord>()(
  "stream",
  {
    name: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  },
) {}

class DisplayOutputRecord extends Schema.TaggedClass<DisplayOutputRecord>()(
  "display",
  {
    kind: Schema.Literals([
      "execute_result",
      "display_data",
      "update_display_data",
    ]),
    data: MimeBundle,
    metadata: Schema.Json,
    transient: Schema.optionalKey(Schema.Json),
  },
) {}

class ErrorOutputRecord extends Schema.TaggedClass<ErrorOutputRecord>()(
  "error",
  {
    name: Schema.String,
    value: Schema.String,
    traceback: Schema.Array(Schema.String),
  },
) {}

class ClearOutputRecord extends Schema.TaggedClass<ClearOutputRecord>()(
  "clear",
  { wait: Schema.Boolean },
) {}

const OutputRecord = Schema.Union([
  StreamOutputRecord,
  DisplayOutputRecord,
  ErrorOutputRecord,
  ClearOutputRecord,
]);

class NotebookCreatedRecord extends Schema.TaggedClass<NotebookCreatedRecord>()(
  "notebook_created",
  {
    ...RecordFields,
    name: Schema.NullOr(Schema.String),
  },
) {}

class CellStartedRecord extends Schema.TaggedClass<CellStartedRecord>()(
  "cell_started",
  {
    ...RecordFields,
    cell_id: CellIdSchema,
    code: Schema.String,
  },
) {}

class CellOutputRecord extends Schema.TaggedClass<CellOutputRecord>()(
  "cell_output",
  {
    ...RecordFields,
    cell_id: CellIdSchema,
    output_index: Schema.Int,
    output: OutputRecord,
  },
) {}

class CellCompletedRecord extends Schema.TaggedClass<CellCompletedRecord>()(
  "cell_completed",
  {
    ...RecordFields,
    cell_id: CellIdSchema,
    status: Schema.Literals(["succeeded", "failed", "interrupted"]),
    message: Schema.NullOr(Schema.String),
  },
) {}

class NotebookClosedRecord extends Schema.TaggedClass<NotebookClosedRecord>()(
  "notebook_closed",
  {
    ...RecordFields,
    reason: Schema.Literals([
      "manual",
      "crashed",
      "startup_failed",
      "storage_failure",
      "unresponsive",
    ]),
  },
) {}

const JournalRecord = Schema.Union([
  NotebookCreatedRecord,
  CellStartedRecord,
  CellOutputRecord,
  CellCompletedRecord,
  NotebookClosedRecord,
]);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(JournalRecord));

export type Entry = Data.TaggedEnum<{
  notebookCreated: {
    readonly name: Option.Option<string>;
  };
  cellStarted: {
    readonly cellId: CellId;
    readonly code: string;
  };
  cellOutput: {
    readonly cellId: CellId;
    readonly outputIndex: number;
    readonly output: Kernel.Output;
  };
  cellCompleted: {
    readonly cellId: CellId;
    readonly status: "succeeded" | "failed" | "interrupted";
    readonly message: Option.Option<string>;
  };
  notebookClosed: {
    readonly reason: NotebookCloseReason;
  };
}>;

export const Entry = Data.taggedEnum<Entry>();

export class Artifact extends Data.Class<{
  readonly id: NotebookId;
  readonly directory: string;
  readonly journalPath: string;
  readonly sequence: Ref.Ref<number>;
  readonly appendLock: Semaphore.Semaphore;
}> {}

export class OperationFailed extends Data.TaggedError(
  "NotebookJournalOperationFailed",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export type Interface = Readonly<{
  create: (
    root: string,
    id: NotebookId,
    name: Option.Option<string>,
  ) => Effect.Effect<Artifact, OperationFailed>;
  append: (
    artifact: Artifact,
    entry: Entry,
  ) => Effect.Effect<void, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "orogeny/Notebook.Journal",
) {}

const outputRecord = (output: Kernel.Output) =>
  Kernel.Output.$match(output, {
    stream: (value) =>
      new StreamOutputRecord({ name: value.name, text: value.text }),
    display: (value) =>
      Option.match(value.transient, {
        onNone: () =>
          new DisplayOutputRecord({
            kind: value.kind,
            data: value.data,
            metadata: value.metadata,
          }),
        onSome: (transient) =>
          new DisplayOutputRecord({
            kind: value.kind,
            data: value.data,
            metadata: value.metadata,
            transient,
          }),
      }),
    error: (value) =>
      new ErrorOutputRecord({
        name: value.name,
        value: value.value,
        traceback: Chunk.toReadonlyArray(value.traceback),
      }),
    clear: (value) => new ClearOutputRecord({ wait: value.wait }),
  });

const recordFrom = (entry: Entry, sequence: number, timestamp: string) =>
  Entry.$match(entry, {
    notebookCreated: (value) =>
      new NotebookCreatedRecord({
        sequence,
        timestamp,
        name: Option.getOrNull(value.name),
      }),
    cellStarted: (value) =>
      new CellStartedRecord({
        sequence,
        timestamp,
        cell_id: value.cellId,
        code: value.code,
      }),
    cellOutput: (value) =>
      new CellOutputRecord({
        sequence,
        timestamp,
        cell_id: value.cellId,
        output_index: value.outputIndex,
        output: outputRecord(value.output),
      }),
    cellCompleted: (value) =>
      new CellCompletedRecord({
        sequence,
        timestamp,
        cell_id: value.cellId,
        status: value.status,
        message: Option.getOrNull(value.message),
      }),
    notebookClosed: (value) =>
      new NotebookClosedRecord({
        sequence,
        timestamp,
        reason: value.reason,
      }),
  });

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const append: Interface["append"] = Effect.fn("Notebook.Journal.append")(
      function* (artifact, entry) {
        yield* artifact.appendLock.withPermit(
          Effect.gen(function* () {
            const sequence = yield* Ref.getAndUpdate(
              artifact.sequence,
              (current) => current + 1,
            );
            const millis = yield* Clock.currentTimeMillis;
            const record = recordFrom(
              entry,
              sequence,
              new Date(millis).toISOString(),
            );
            const encoded = yield* encodeRecord(record).pipe(
              Effect.mapError(
                (cause) =>
                  new OperationFailed({
                    operation: "encode notebook journal record",
                    message: messageFrom(cause),
                  }),
              ),
            );
            yield* files
              .writeFileString(artifact.journalPath, `${encoded}\n`, {
                flag: "a",
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OperationFailed({
                      operation: "append notebook journal record",
                      message: messageFrom(cause),
                    }),
                ),
              );
          }),
        );
      },
    );

    const create: Interface["create"] = Effect.fn("Notebook.Journal.create")(
      function* (root, id, name) {
        const directory = paths.join(root, id);
        const journalPath = paths.join(directory, "notebook.jsonl");
        yield* pipe(
          files.makeDirectory(root, { recursive: true, mode: 0o700 }),
          Effect.andThen(files.makeDirectory(directory, { mode: 0o700 })),
          Effect.andThen(
            files.writeFileString(journalPath, "", {
              flag: "wx",
              mode: 0o600,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new OperationFailed({
                operation: "create notebook artifact",
                message: messageFrom(cause),
              }),
          ),
        );
        const artifact = new Artifact({
          id,
          directory,
          journalPath,
          sequence: yield* Ref.make(0),
          appendLock: yield* Semaphore.make(1),
        });
        yield* append(artifact, Entry.notebookCreated({ name }));
        return artifact;
      },
    );

    return Service.of({ create, append });
  }),
);

export * as Journal from "./journal.ts";
