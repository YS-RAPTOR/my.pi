import { Schema } from "effect";

export const HOST = "127.0.0.1";

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

export class ConnectionInfo extends Schema.Class<ConnectionInfo>("ConnectionInfo")({
  ip: Schema.Literal(HOST),
  transport: Schema.Literal("tcp"),
  shell_port: Port,
  iopub_port: Port,
  stdin_port: Port,
  control_port: Port,
  hb_port: Port,
  signature_scheme: Schema.Literal("hmac-sha256"),
  key: Schema.String,
  kernel_name: Schema.Literal("deno"),
}) {}

export class Header extends Schema.Class<Header>("Header")({
  msg_id: Schema.String,
  session: Schema.String,
  username: Schema.String,
  date: Schema.String,
  msg_type: Schema.String,
  version: Schema.String,
}) {}

export class Message extends Schema.Class<Message>("Message")({
  identities: Schema.Array(Schema.Uint8Array),
  header: Header,
  parentHeader: Schema.Json,
  metadata: Schema.Json,
  content: Schema.Json,
  buffers: Schema.Array(Schema.Uint8Array),
}) {}

export const Envelope = Schema.TupleWithRest(
  Schema.Tuple([
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
  ]),
  [Schema.Uint8Array],
);

export class MimeBundle extends Schema.Opaque<MimeBundle>()(
  Schema.Record(Schema.String, Schema.Json),
) {}

export class Ok extends Schema.Class<Ok>("Ok")({
  status: Schema.Literal("ok"),
}) {}

export class StreamOutput extends Schema.Class<StreamOutput>("StreamOutput")({
  name: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
}) {}

export class DisplayOutput extends Schema.Class<DisplayOutput>("DisplayOutput")({
  data: MimeBundle,
  metadata: Schema.Json,
  transient: Schema.optionalKey(Schema.Json),
  execution_count: Schema.optionalKey(Schema.Int),
}) {}

export class ErrorOutput extends Schema.Class<ErrorOutput>("ErrorOutput")({
  ename: Schema.String,
  evalue: Schema.String,
  traceback: Schema.Array(Schema.String),
}) {}

export class Clear extends Schema.Class<Clear>("Clear")({
  wait: Schema.Boolean,
}) {}

export class Sentinel extends Schema.Class<Sentinel>("Sentinel")({
  token: Schema.String,
}) {}

export class Reply extends Schema.Class<Reply>("Reply")({
  status: Schema.Literals(["ok", "error"]),
  evalue: Schema.optionalKey(Schema.String),
}) {}

export const HeaderJson = Schema.fromJsonString(Header);
export const JsonFrame = Schema.fromJsonString(Schema.Json);
