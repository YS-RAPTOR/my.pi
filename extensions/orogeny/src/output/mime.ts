import * as Pi from "@earendil-works/pi-coding-agent";
import { extension } from "mime-types";
import {
  Chunk,
  Data,
  Effect,
  Match,
  pipe,
  Predicate,
  Schema,
  String as Str,
} from "effect";
import { Jupyter } from "#o/jupyter";

export type Handling = "concatenate" | "indivisible" | "reference";
export type Encoding = "utf8" | "json" | "base64";
export type Rule = readonly [handling: Handling, encoding: Encoding];

export class Representation extends Data.Class<{
  readonly mime: string;
  readonly handling: Handling;
  readonly value: string | Uint8Array;
}> {}

const utf8 = Schema.decodeUnknownEffect(Schema.String);
const base64 = Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64);
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const JsonText = Schema.fromJsonString(Schema.Json);

export const ruleFor = pipe(
  Match.type<string>(),
  Match.withReturnType<Rule>(),
  Match.when(Str.startsWith("text/"), () => ["concatenate", "utf8"]),
  Match.when("application/json", () => ["concatenate", "json"]),
  Match.when("image/svg+xml", () => ["indivisible", "utf8"]),
  Match.when(Str.startsWith("image/"), () => ["indivisible", "base64"]),
  Match.when("application/javascript", () => ["reference", "utf8"]),
  Match.whenOr(
    Str.startsWith("audio/"),
    Str.startsWith("video/"),
    "application/pdf",
    () => ["reference", "base64"],
  ),
  Match.orElse(() => ["reference", "json"]),
);

export const normalize = (bundle: Jupyter.MimeBundle) =>
  pipe(
    Effect.forEach(Object.entries(bundle), ([mime, input]) => {
      const [handling, encoding] = ruleFor(mime);
      return pipe(
        Match.value(encoding),
        Match.when("utf8", () => utf8(input)),
        Match.when("base64", () => base64(input)),
        Match.when("json", () => json(input)),
        Match.exhaustive,
        Effect.map((value) => new Representation({ mime, handling, value })),
      );
    }),
    Effect.map(Chunk.fromIterable),
  );

export const fitsInline = (representations: Chunk.Chunk<Representation>) => {
  const allConcatenate = Chunk.every(
    representations,
    (representation) => representation.handling === "concatenate",
  );
  if (!allConcatenate) return false;

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

const rank = pipe(
  Match.type<string>(),
  Match.withReturnType<number>(),
  Match.when("image/svg+xml", () => 10),
  Match.when(Str.startsWith("image/"), () => 0),
  Match.when("application/json", () => 20),
  Match.when("text/html", () => 30),
  Match.when("text/markdown", () => 40),
  Match.when("text/latex", () => 50),
  Match.when("text/plain", () => 60),
  Match.when(Str.startsWith("text/"), () => 70),
  Match.when("application/pdf", () => 80),
  Match.orElse(() => 90),
);

export const preferred = <A>(
  entries: ReadonlyArray<readonly [mime: string, value: A]>,
) => [...entries].sort(([left], [right]) => rank(left) - rank(right))[0];

export const decodeText = (mime: string, value: Schema.Json | undefined) =>
  mime.startsWith("text/")
    ? Schema.decodeUnknownEffect(Schema.String)(value)
    : Schema.encodeUnknownEffect(JsonText)(value);

export const resize = (bytes: Uint8Array, mime: string) =>
  pipe(
    Effect.tryPromise({
      try: () => Pi.resizeImage(bytes, mime),
      catch: () => null,
    }),
    Effect.orElseSucceed(() => null),
  );

export const filename = (mime: string) => {
  const suffix = extension(mime);
  const encoded = encodeURIComponent(mime).replaceAll(".", "%2E");
  return `${encoded}${suffix === false ? "" : `.${suffix}`}`;
};

export const mimeFromFilename = (file: string) =>
  pipe(file, Str.split("."), ([mime]) => decodeURIComponent(mime));
