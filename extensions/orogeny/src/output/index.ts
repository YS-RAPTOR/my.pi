import { Buffer } from "node:buffer";
import * as Pi from "@earendil-works/pi-coding-agent";
import {
  Chunk,
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  pipe,
  Predicate,
  PubSub,
  Schema,
  String as Str,
  SynchronizedRef,
} from "effect";
import { Jupyter } from "#o/jupyter";
import * as Mime from "./mime.ts";
import { Cursor, OutputLine, OutputRecord, Position } from "./types.ts";

export class OperationFailed extends Data.TaggedError("CellOutput")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type Content = Data.TaggedEnum<{
  text: { readonly text: string };
  image: { readonly data: string; readonly mimeType: string };
}>;

export const Content = Data.taggedEnum<Content>();

export class ReadInput extends Data.Class<{
  readonly cursor: Cursor;
  readonly sealed: boolean;
  readonly maxBytes: number;
  readonly maxLines: number;
}> {}

export class ReadResult extends Data.Class<{
  readonly content: Chunk.Chunk<Content>;
  readonly cursor: Cursor;
  readonly hasMore: boolean;
  readonly bytes: number;
  readonly lines: number;
  readonly boundary: "exhausted" | "limit" | "image";
}> {}

export class Handle extends Data.Class<{
  readonly append: (output: Jupyter.Output) => Effect.Effect<void, OperationFailed>;
  readonly read: (input: ReadInput) => Effect.Effect<ReadResult, OperationFailed>;
  readonly updates: PubSub.PubSub<void>;
}> {}

export type Interface = Readonly<{
  open: (directory: string) => Effect.Effect<Handle, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/CellOutput") {}

class State extends Data.Class<{
  readonly streamBytes: number;
  readonly rangeOpen: boolean;
  readonly channel: Option.Option<"stdout" | "stderr">;
}> {}

class ProjectedRecord extends Data.Class<{
  readonly text: string;
  readonly image: Option.Option<Pi.ResizedImage>;
  readonly open: boolean;
}> {}

class TextSlice extends Data.Class<{
  readonly text: string;
  readonly position: Position;
  readonly bytes: number;
  readonly lines: number;
  readonly status: "complete" | "limit" | "open";
}> {
  static empty(position: Position, status: TextSlice["status"]) {
    return new TextSlice({ text: "", position, bytes: 0, lines: 0, status });
  }
}

class Page extends Data.Class<{
  readonly position: Position;
  readonly content: Chunk.Chunk<Content>;
  readonly bytes: number;
  readonly lines: number;
}> {
  result(boundary: ReadResult["boundary"], hasMore: boolean) {
    return new ReadResult({
      content: this.content,
      cursor: Cursor.from(this.position),
      hasMore,
      bytes: this.bytes,
      lines: this.lines,
      boundary,
    });
  }
}

type StoredRecord = typeof OutputRecord.Type;
type Snapshot = Readonly<{ readonly output: string; readonly streams: Uint8Array }>;
type Project = (index: number) => Effect.Effect<ProjectedRecord, OperationFailed>;

const DIRECTORY = { mode: 0o700 } as const;
const PARENT = { ...DIRECTORY, recursive: true } as const;
const FILE = { mode: 0o600 } as const;
const CREATE_FILE = { ...FILE, flag: "wx" } as const;

const failed = (operation: string, cause: unknown) =>
  new OperationFailed({ operation, message: globalThis.String(cause) });

const mapFailed = (operation: string) =>
  Effect.mapError((cause: unknown) => failed(operation, cause));

const ensure = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(failed("read cell output", message));

const utf8Boundary = (bytes: Uint8Array, offset: number) => {
  let boundary = Math.min(offset, bytes.length);
  while (boundary > 0 && (bytes[boundary] ?? 0) >> 6 === 2) boundary -= 1;
  return boundary;
};

const sliceText = Effect.fnUntraced(function* (
  projection: ProjectedRecord,
  page: Page,
  input: ReadInput,
) {
  const position = page.position;
  const maxBytes = input.maxBytes - page.bytes;
  const maxLines = input.maxLines - page.lines;
  const lines = Chunk.fromIterable(Str.linesWithSeparators(projection.text));
  const lineCount = Chunk.size(lines);

  yield* ensure(
    position.line < lineCount || (position.line === lineCount && position.byte === undefined),
    "Cursor is outside projected content",
  );

  if (position.line === lineCount)
    return TextSlice.empty(position, projection.open ? "open" : "complete");

  const start = position.byte ?? 0;
  const [, measured] = pipe(
    lines,
    Chunk.drop(position.line),
    Chunk.take(maxLines),
    Chunk.map((text, index) => {
      const bytes = Buffer.from(text);
      return { value: bytes.subarray(index === 0 ? start : 0), end: bytes.length };
    }),
    Chunk.mapAccum(0, (total, line) => {
      const bytes = total + line.value.length;
      return [bytes, { ...line, total: bytes }] as const;
    }),
  );
  const first = Chunk.getUnsafe(measured, 0);

  yield* ensure(
    start <= first.end && (start === first.end || (first.value[0] ?? 0) >> 6 !== 2),
    "Cursor splits a UTF-8 code point",
  );

  const selected = pipe(
    measured,
    Chunk.takeWhile((line) => line.total <= maxBytes),
  );

  if (Chunk.isEmpty(selected)) {
    if (page.bytes > 0 || page.lines > 0) return TextSlice.empty(position, "limit");

    const take = utf8Boundary(first.value, maxBytes);
    return new TextSlice({
      text: first.value.subarray(0, take).toString("utf8"),
      position: new Position({
        output: position.output,
        line: position.line,
        byte: start + take || undefined,
      }),
      bytes: take,
      lines: take === 0 ? 0 : 1,
      status: "limit",
    });
  }

  const consumed = Chunk.size(selected);
  const delivered = pipe(
    selected,
    Chunk.filter((line) => line.value.length > 0),
    Chunk.size,
  );
  const nextLine = position.line + consumed;
  const last = Chunk.lastUnsafe(selected);
  const open = projection.open && nextLine === lineCount;
  const openLine = open && last.value[last.value.length - 1] !== 0x0a;
  const text = pipe(
    selected,
    Chunk.map((line) => line.value),
    Chunk.toReadonlyArray,
    Buffer.concat,
    (bytes) => bytes.toString("utf8"),
  );

  return new TextSlice({
    text,
    position: new Position({
      output: position.output,
      line: openLine ? nextLine - 1 : nextLine,
      byte: openLine ? last.end : undefined,
    }),
    bytes: last.total,
    lines: delivered,
    status: nextLine < lineCount ? "limit" : open ? "open" : "complete",
  });
});

const paginate = Effect.fnUntraced(function* (
  input: ReadInput,
  recordCount: number,
  project: Project,
  page = new Page({ position: input.cursor.position, content: Chunk.empty(), bytes: 0, lines: 0 }),
): Effect.fn.Return<ReadResult, OperationFailed> {
  if (page.position.output === recordCount) return page.result("exhausted", false);
  if (page.bytes >= input.maxBytes || page.lines >= input.maxLines)
    return page.result("limit", true);

  const projection = yield* project(page.position.output);
  const slice = yield* sliceText(projection, page, input);
  const next = new Page({
    position: slice.position,
    content:
      slice.text.length === 0
        ? page.content
        : Chunk.append(page.content, Content.text({ text: slice.text })),
    bytes: page.bytes + slice.bytes,
    lines: page.lines + slice.lines,
  });

  const full = next.bytes >= input.maxBytes || next.lines >= input.maxLines;
  if (slice.status !== "complete")
    return next.result(
      slice.status === "limit" || full ? "limit" : "exhausted",
      slice.status === "limit",
    );

  const hasImage = Option.isSome(projection.image);
  if (full && hasImage) return next.result("limit", true);

  const advanced = new Page({
    position: new Position({ output: next.position.output + 1, line: 0, byte: undefined }),
    content: Option.match(projection.image, {
      onNone: () => next.content,
      onSome: (image) => Chunk.append(next.content, Content.image(image)),
    }),
    bytes: next.bytes,
    lines: next.lines,
  });

  const hasMore = advanced.position.output < recordCount;
  if (hasImage) return advanced.result("image", hasMore);
  if (full) return advanced.result("limit", hasMore);

  return yield* paginate(input, recordCount, project, advanced);
});

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const open: Interface["open"] = Effect.fn("CellOutput.open")(function* (directory) {
      const outputPath = paths.join(directory, "outputs.jsonl");
      const streamPath = paths.join(directory, "streams.log");

      yield* pipe(
        files.makeDirectory(paths.dirname(directory), PARENT),
        Effect.andThen(files.makeDirectory(directory, DIRECTORY)),
        Effect.andThen(
          Effect.forEach(
            [outputPath, streamPath],
            (path) => files.writeFileString(path, "", CREATE_FILE),
            {
              discard: true,
            },
          ),
        ),
        mapFailed("create cell output"),
      );

      const state = yield* SynchronizedRef.make(
        new State({
          streamBytes: 0,
          rangeOpen: false,
          channel: Option.none(),
        }),
      );
      const updates = yield* PubSub.sliding<void>(1);

      const appendRecord = (record: typeof OutputRecord.Type) =>
        pipe(
          Schema.encodeEffect(OutputLine)(record),
          Effect.flatMap((line) => files.writeFileString(outputPath, `${line}\n`, { flag: "a" })),
          mapFailed("append cell output record"),
        );

      const externalize = Effect.fn("CellOutput.externalize")(function* (
        representations: Chunk.Chunk<Mime.Representation>,
      ) {
        const { id, dir } = yield* pipe(
          crypto.randomUUIDv4,
          Effect.map((uuid) => `artifact_${uuid}`),
          Effect.map((id) => ({ id, dir: paths.join(directory, id) })),
          Effect.tap(({ dir }) => files.makeDirectory(dir, DIRECTORY)),
          mapFailed("create cell output artifact"),
        );

        yield* Effect.forEach(
          representations,
          ({ mime, value }) =>
            pipe(
              paths.join(dir, Mime.filename(mime)),
              (path) =>
                Predicate.isUint8Array(value)
                  ? files.writeFile(path, value, FILE)
                  : files.writeFileString(path, value, FILE),
              mapFailed(`write ${mime} representation`),
            ),
          { concurrency: "unbounded", discard: true },
        );
        return id;
      });

      const append: Handle["append"] = (output: Jupyter.Output) =>
        pipe(
          state,
          SynchronizedRef.updateEffect((current) =>
            Effect.gen(function* () {
              const observedAt = yield* pipe(DateTime.now, Effect.map(DateTime.formatIso));
              const closed = new State({ ...current, rangeOpen: false });

              if (Jupyter.Output.$is("stream")(output)) {
                if (output.text.length === 0) return current;
                const marker = `[${observedAt} ${output.name}] `;
                const prefix = Option.contains(current.channel, output.name)
                  ? ""
                  : `${Option.isSome(current.channel) ? "\n" : ""}${marker}`;
                const marked = `${prefix}${output.text.replaceAll("\n", `\n${marker}`)}`;
                const value = output.text.endsWith("\n") ? marked.slice(0, -marker.length) : marked;
                if (!current.rangeOpen)
                  yield* appendRecord({
                    type: "stream",
                    timestamp: observedAt,
                    offset: current.streamBytes,
                  });
                yield* pipe(
                  files.writeFileString(streamPath, value, { flag: "a" }),
                  mapFailed("append cell stream output"),
                );
                return new State({
                  streamBytes: current.streamBytes + Buffer.byteLength(value),
                  rangeOpen: true,
                  channel: output.text.endsWith("\n") ? Option.none() : Option.some(output.name),
                });
              }

              if (Jupyter.Output.$is("clear")(output)) {
                yield* appendRecord({
                  type: "clear_output",
                  timestamp: observedAt,
                  wait: output.wait,
                });
                return closed;
              }

              if (Jupyter.Output.$is("error")(output)) {
                yield* appendRecord({
                  type: "error",
                  timestamp: observedAt,
                  name: output.name,
                  value: output.value,
                  traceback: Chunk.toReadonlyArray(output.traceback),
                });
                return closed;
              }

              const representations = yield* pipe(
                Mime.normalize(output.data),
                mapFailed("decode cell output MIME bundle"),
              );

              if (output.kind === "execute_result" && Option.isNone(output.executionCount))
                return yield* failed("store execute result", "Missing execution count");

              const storage = Mime.fitsInline(representations)
                ? { value: output.data }
                : { artifact_id: yield* externalize(representations) };

              yield* appendRecord({
                ...storage,
                type: output.kind,
                timestamp: observedAt,
                metadata: output.metadata,
                execution_count: Option.getOrUndefined(output.executionCount),
                transient: Option.getOrUndefined(output.transient),
              });
              return closed;
            }),
          ),
          Effect.andThen(PubSub.publish(updates, undefined)),
          Effect.asVoid,
        );

      const project = (
        snapshot: Snapshot,
        records: ReadonlyArray<StoredRecord>,
        sealed: boolean,
      ): Project =>
        Effect.fn("CellOutput.project")(function* (index) {
          const record = records[index];
          if (record === undefined)
            return yield* failed("read cell output", "Missing output record");

          if (record.type === "stream") {
            const next = records.slice(index + 1).find((candidate) => candidate.type === "stream");
            const end = next?.offset ?? snapshot.streams.length;
            yield* ensure(
              record.offset <= end && end <= snapshot.streams.length,
              "Invalid stream byte range",
            );
            return new ProjectedRecord({
              text: Buffer.from(snapshot.streams.subarray(record.offset, end)).toString("utf8"),
              image: Option.none(),
              open: !sealed && index === records.length - 1,
            });
          }

          if (record.type === "error") {
            return new ProjectedRecord({
              text: `${record.traceback.join("\n")}${record.traceback.length === 0 ? "" : "\n"}${record.name}: ${record.value}\n`,
              image: Option.none(),
              open: false,
            });
          }

          if (record.type === "clear_output") {
            return new ProjectedRecord({
              text: `[clear_output wait=${record.wait}]\n`,
              image: Option.none(),
              open: false,
            });
          }

          if (record.value !== undefined) {
            const selected = Mime.preferred(Object.entries(record.value));
            if (selected === undefined)
              return yield* failed("read cell output", "MIME bundle is empty");

            const [mime, value] = selected;
            if (Mime.ruleFor(mime)[0] !== "concatenate")
              return yield* failed(
                "read cell output",
                "Inline MIME representation is not concatenate",
              );

            return new ProjectedRecord({
              text: yield* pipe(Mime.decodeText(mime, value), mapFailed("read cell output")),
              image: Option.none(),
              open: false,
            });
          }

          const artifactId = record.artifact_id;
          const artifactPath = paths.join(directory, artifactId);
          const entries = yield* pipe(
            files.readDirectory(artifactPath),
            Effect.map((files) =>
              files.map((file) => [Mime.mimeFromFilename(file), file] as const),
            ),
            mapFailed("read cell output"),
          );
          const selected = Mime.preferred(entries);
          if (selected === undefined)
            return yield* failed("read cell output", "MIME bundle is empty");

          const [mime, file] = selected;
          const [handling] = Mime.ruleFor(mime);
          const annotation = entries.map(([available]) => available).join(",");
          const reference = `[${artifactId}](<${artifactPath}>){${annotation}}\n`;
          if (handling === "reference")
            return new ProjectedRecord({ text: reference, image: Option.none(), open: false });

          const representationPath = paths.join(artifactPath, file);
          if (handling === "concatenate")
            return new ProjectedRecord({
              text: yield* pipe(
                files.readFileString(representationPath),
                mapFailed("read cell output"),
              ),
              image: Option.none(),
              open: false,
            });

          const resized = yield* pipe(
            files.readFile(representationPath),
            mapFailed("read cell output"),
            Effect.flatMap((bytes) => Mime.resize(bytes, mime)),
          );
          return new ProjectedRecord({
            text: resized === null ? reference : `[Image](<${artifactPath}>){${annotation}}\n`,
            image: Option.fromNullOr(resized),
            open: false,
          });
        });

      const read: Handle["read"] = Effect.fn("CellOutput.read")(function* (input) {
        const snapshot: Snapshot = yield* pipe(
          state,
          SynchronizedRef.modifyEffect((current) =>
            pipe(
              Effect.all({
                output: files.readFileString(outputPath),
                streams: files.readFile(streamPath),
              }),
              Effect.map((value) => [value, current] as const),
            ),
          ),
          mapFailed("snapshot cell output"),
        );
        const finalLf = snapshot.output.lastIndexOf("\n");
        const encoded = finalLf < 0 ? [] : snapshot.output.slice(0, finalLf).split("\n");
        const records = yield* pipe(
          Effect.forEach(encoded, (line) => Schema.decodeUnknownEffect(OutputLine)(line)),
          mapFailed("read cell output"),
        );
        const initial = input.cursor.position;

        yield* ensure(initial.output <= records.length, "Cursor is beyond committed output");
        yield* ensure(
          initial.output !== records.length || (initial.line === 0 && initial.byte === undefined),
          "End cursor has content coordinates",
        );

        return yield* paginate(input, records.length, project(snapshot, records, input.sealed));
      });

      return new Handle({ append, read, updates });
    });

    return { open };
  }),
);

export * from "./types.ts";
export * as CellOutput from "./index.ts";
