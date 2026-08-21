import { Schema } from "effect";

const Common = { timestamp: Schema.String };
const Bundle = Schema.Record(Schema.String, Schema.Json);
const Mime = {
  ...Common,
  value: Schema.optional(Bundle),
  artifact_id: Schema.optional(Schema.String),
  execution_count: Schema.optional(Schema.Int),
  metadata: Schema.Json,
  transient: Schema.optional(Schema.Json),
};

export const OutputRecord = Schema.Union([
  Schema.Struct({
    ...Common,
    type: Schema.Literal("stream"),
    offset: Schema.Int,
  }),
  Schema.Struct({
    ...Mime,
    type: Schema.Literals([
      "execute_result",
      "display_data",
      "update_display_data",
    ]),
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
