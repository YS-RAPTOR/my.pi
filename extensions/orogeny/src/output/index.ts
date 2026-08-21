import { Buffer } from "node:buffer";
import * as Pi from "@earendil-works/pi-coding-agent";
import { extension } from "mime-types";
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
  Predicate,
  Schema,
  SynchronizedRef,
} from "effect";
import { Jupyter } from "#o/jupyter";
import { OutputLine, OutputRecord } from "./types.ts";

export class OperationFailed extends Data.TaggedError("CellOutput")<{
  readonly operation: string;
  readonly message: string;
}> {}

export class Handle extends Data.Class<{
  readonly append: (
    output: Jupyter.Output,
  ) => Effect.Effect<void, OperationFailed>;
}> {}

export type Interface = Readonly<{
  open: (directory: string) => Effect.Effect<Handle, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "orogeny/CellOutput",
) {}

class State extends Data.Class<{
  readonly streamBytes: number;
  readonly rangeOpen: boolean;
  readonly channel: Option.Option<"stdout" | "stderr">;
}> {}

const failed = (operation: string, cause: unknown) =>
  new OperationFailed({ operation, message: globalThis.String(cause) });

const mapFailed = (operation: string) =>
  Effect.mapError((cause: unknown) => failed(operation, cause));

type Handling = "concatenate" | "indivisible" | "reference";
type Encoding = "utf8" | "json" | "base64";
type Rule = readonly [handling: Handling, encoding: Encoding];

class Representation extends Data.Class<{
  readonly mime: string;
  readonly handling: Handling;
  readonly value: string | Uint8Array;
}> {}

const utf8 = Schema.decodeUnknownEffect(Schema.String);
const base64 = Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64);
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const normalizeValue = Effect.fn("CellOutput.normalizeRepresentation")(
  function* (encoding: Encoding, input: Schema.Json) {
    if (encoding === "utf8") return yield* utf8(input);
    if (encoding === "base64") return yield* base64(input);
    return yield* json(input);
  },
);

const ruleFor = (mime: string): Rule => {
  if (mime.startsWith("text/")) return ["concatenate", "utf8"];
  if (mime === "application/json") return ["concatenate", "json"];
  if (mime === "image/svg+xml") return ["indivisible", "utf8"];
  if (mime.startsWith("image/")) return ["indivisible", "base64"];
  if (mime === "application/javascript") return ["reference", "utf8"];
  if (
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime === "application/pdf"
  )
    return ["reference", "base64"];
  return ["reference", "json"];
};

const normalize = (bundle: Jupyter.MimeBundle) =>
  pipe(
    Effect.forEach(Object.entries(bundle), ([mime, input]) => {
      const [handling, encoding] = ruleFor(mime);
      return pipe(
        normalizeValue(encoding, input),
        Effect.map((value) => new Representation({ mime, handling, value })),
        mapFailed(`decode ${mime} representation`),
      );
    }),
    Effect.map(Chunk.fromIterable),
  );

const fitsInline = (representations: Chunk.Chunk<Representation>) => {
  if (
    !Chunk.every(
      representations,
      (representation) =>
        representation.handling === "concatenate" &&
        Predicate.isString(representation.value),
    )
  )
    return false;
  const measurement = pipe(
    representations,
    Chunk.reduce({ bytes: 0, lines: 0 }, (total, representation) => {
      if (!Predicate.isString(representation.value)) return total;
      const measured = Pi.truncateHead(representation.value);
      return {
        bytes: total.bytes + measured.totalBytes,
        lines: total.lines + measured.totalLines,
      };
    }),
  );
  return (
    measurement.bytes <= Pi.DEFAULT_MAX_BYTES &&
    measurement.lines <= Pi.DEFAULT_MAX_LINES
  );
};

const DIRECTORY = { mode: 0o700 } as const;
const PARENT = { ...DIRECTORY, recursive: true } as const;
const FILE = { mode: 0o600 } as const;
const CREATE_FILE = { ...FILE, flag: "wx" } as const;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const open: Interface["open"] = Effect.fn("CellOutput.open")(
      function* (directory) {
        const outputPath = paths.join(directory, "outputs.jsonl");
        const streamPath = paths.join(directory, "streams.log");

        yield* pipe(
          files.makeDirectory(paths.dirname(directory), PARENT),
          Effect.andThen(files.makeDirectory(directory, DIRECTORY)),
          Effect.andThen(
            Effect.forEach(
              [outputPath, streamPath],
              (path) => files.writeFileString(path, "", CREATE_FILE),
              { discard: true },
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

        const appendRecord = (record: typeof OutputRecord.Type) =>
          pipe(
            Schema.encodeEffect(OutputLine)(record),
            Effect.flatMap((line) =>
              files.writeFileString(outputPath, `${line}\n`, { flag: "a" }),
            ),
            mapFailed("append cell output record"),
          );

        const externalize = Effect.fn("CellOutput.externalize")(function* (
          representations: Chunk.Chunk<Representation>,
        ) {
          const id = `artifact_${crypto.randomUUID()}`;
          const directoryPath = paths.join(directory, id);
          yield* pipe(
            files.makeDirectory(directoryPath, DIRECTORY),
            mapFailed("create cell output artifact"),
          );
          yield* Effect.forEach(
            representations,
            (representation) => {
              const { mime, value } = representation;
              const suffix = extension(mime);
              const encoded = encodeURIComponent(mime).replaceAll(".", "%2E");
              const file = `${encoded}${suffix === false ? "" : `.${suffix}`}`;
              const path = paths.join(directoryPath, file);
              const write = Predicate.isUint8Array(value)
                ? files.writeFile(path, value, FILE)
                : files.writeFileString(path, value, FILE);
              return pipe(write, mapFailed(`write ${mime} representation`));
            },
            { concurrency: "unbounded", discard: true },
          );
          return id;
        });

        const append: Handle["append"] = (output) =>
          pipe(
            state,
            SynchronizedRef.updateEffect((current) =>
              Effect.gen(function* () {
                const millis = yield* Clock.currentTimeMillis;
                const observedAt = new Date(millis).toISOString();
                const closed = new State({ ...current, rangeOpen: false });

                if (Jupyter.Output.$is("stream")(output)) {
                  if (output.text.length === 0) return current;
                  const marker = `[${observedAt} ${output.name}] `;
                  const prefix = Option.contains(current.channel, output.name)
                    ? ""
                    : `${Option.isSome(current.channel) ? "\n" : ""}${marker}`;
                  const marked = `${prefix}${output.text.replaceAll("\n", `\n${marker}`)}`;
                  const value = output.text.endsWith("\n")
                    ? marked.slice(0, -marker.length)
                    : marked;
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
                    channel: output.text.endsWith("\n")
                      ? Option.none()
                      : Option.some(output.name),
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

                const representations = yield* normalize(output.data);
                const isInline = fitsInline(representations);
                const artifactId = isInline
                  ? undefined
                  : yield* externalize(representations);
                if (
                  output.kind === "execute_result" &&
                  Option.isNone(output.executionCount)
                )
                  return yield* failed(
                    "store execute result",
                    "Missing execution count",
                  );
                yield* appendRecord({
                  type: output.kind,
                  timestamp: observedAt,
                  metadata: output.metadata,
                  value: isInline ? output.data : undefined,
                  artifact_id: artifactId,
                  execution_count: Option.getOrUndefined(output.executionCount),
                  transient: Option.getOrUndefined(output.transient),
                });
                return closed;
              }),
            ),
          );

        return new Handle({ append });
      },
    );

    return { open };
  }),
);

export * from "./types.ts";
export * as CellOutput from "./index.ts";
