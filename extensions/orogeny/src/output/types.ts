import { Schema, SchemaGetter, pipe } from "effect";

const CursorPattern = /^oc1:o(\d{1,15}):l(\d{1,15})(?::b([1-9]\d{0,14}))?$/;

export class Position extends Schema.Class<Position>("OutputPosition")({
  output: Schema.Natural,
  line: Schema.Natural,
  byte: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
}) {}

export class Cursor extends Schema.Class<Cursor>("OutputCursor")({
  position: Position,
}) {
  static from(position: Position) {
    return new Cursor({ position });
  }

  static format({ output, line, byte }: Position) {
    return `oc1:o${output}:l${line}${byte === undefined ? "" : `:b${byte}`}`;
  }

  static start() {
    return Cursor.from(new Position({ output: 0, line: 0, byte: undefined }));
  }

  static fromString(value: string) {
    const [, output, line, byte] = CursorPattern.exec(value) ?? [];
    return Cursor.from(
      Schema.decodeUnknownSync(Position)({
        output: Number(output),
        line: Number(line),
        byte: byte === undefined ? undefined : Number(byte),
      }),
    );
  }

  toString() {
    return Cursor.format(this.position);
  }

  static readonly FromString = pipe(
    Schema.String.check(Schema.isPattern(CursorPattern)),
    Schema.decodeTo(Cursor, {
      decode: SchemaGetter.transform(Cursor.fromString),
      encode: SchemaGetter.transform(({ position }) => Cursor.format(position)),
    }),
  );
}

const Common = { timestamp: Schema.String };
const Bundle = Schema.Record(Schema.String, Schema.Json);
const ArtifactId = Schema.String.check(Schema.isPattern(/^artifact_[\w-]+$/));
const Mime = {
  ...Common,
  execution_count: Schema.optional(Schema.Int),
  metadata: Schema.Json,
  transient: Schema.optional(Schema.Json),
};

const StoredMime = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Union([
    Schema.Struct({
      ...Mime,
      ...fields,
      value: Bundle,
      artifact_id: Schema.optionalKey(Schema.Never),
    }),
    Schema.Struct({
      ...Mime,
      ...fields,
      artifact_id: ArtifactId,
      value: Schema.optionalKey(Schema.Never),
    }),
  ]);

export const OutputRecord = Schema.Union([
  Schema.Struct({
    ...Common,
    type: Schema.Literal("stream"),
    offset: Schema.Int,
  }),
  StoredMime({
    type: Schema.Literals(["execute_result", "display_data", "update_display_data"]),
  }),
  Schema.Struct({
    ...Common,
    type: Schema.Literal("error"),
    name: Schema.String,
    value: Schema.String,
    traceback: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...Common,
    type: Schema.Literal("clear_output"),
    wait: Schema.Boolean,
  }),
]);

export const OutputLine = Schema.fromJsonString(OutputRecord);
