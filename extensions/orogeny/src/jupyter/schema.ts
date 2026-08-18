import { Schema } from "effect";

const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
);
export class ConnectionInfo extends Schema.Opaque<ConnectionInfo>()(
  Schema.Struct({
    ip: Schema.Literal("127.0.0.1"),
    transport: Schema.Literal("tcp"),
    shell_port: Port,
    iopub_port: Port,
    stdin_port: Port,
    control_port: Port,
    hb_port: Port,
    signature_scheme: Schema.Literal("hmac-sha256"),
    key: Schema.String.check(Schema.isMinLength(1)),
    kernel_name: Schema.Literal("deno"),
  }),
) {}

export class JupyterHeader extends Schema.Opaque<JupyterHeader>()(
  Schema.Struct({
    msg_id: Schema.String,
    session: Schema.String,
    username: Schema.String,
    date: Schema.String,
    msg_type: Schema.String,
    version: Schema.String,
  }),
) {}

export class JupyterMessage extends Schema.Opaque<JupyterMessage>()(
  Schema.Struct({
    identities: Schema.Array(Schema.Uint8Array),
    header: JupyterHeader,
    parentHeader: Schema.Json,
    metadata: Schema.Json,
    content: Schema.Json,
    buffers: Schema.Array(Schema.Uint8Array),
  }),
) {}

const JupyterEnvelopeFramesSchema = Schema.TupleWithRest(
  Schema.Tuple([
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
  ]),
  [Schema.Uint8Array],
);

export type JupyterEnvelopeFrames =
  typeof JupyterEnvelopeFramesSchema.Type;
export const JupyterEnvelopeFrames =
  Schema.Opaque<JupyterEnvelopeFrames>()(JupyterEnvelopeFramesSchema);

export class MimeBundle extends Schema.Opaque<MimeBundle>()(
  Schema.Record(Schema.String, Schema.Json),
) {}

export class KernelInfoRequestContent extends Schema.Opaque<KernelInfoRequestContent>()(
  Schema.Struct({}),
) {}

export class KernelInfoReplyContent extends Schema.Opaque<KernelInfoReplyContent>()(
  Schema.Struct({
    status: Schema.Literal("ok"),
    implementation: Schema.String,
  }),
) {}

export class ExecuteRequestContent extends Schema.Opaque<ExecuteRequestContent>()(
  Schema.Struct({
    code: Schema.String,
    silent: Schema.Boolean,
    store_history: Schema.Boolean,
    user_expressions: Schema.Json,
    allow_stdin: Schema.Boolean,
    stop_on_error: Schema.Boolean,
  }),
) {}

export type JupyterRequestContent =
  | KernelInfoRequestContent
  | ExecuteRequestContent
  | InterruptRequestContent
  | ShutdownRequestContent;

export class InterruptRequestContent extends Schema.Opaque<InterruptRequestContent>()(
  Schema.Struct({}),
) {}

export class InterruptReplyContent extends Schema.Opaque<InterruptReplyContent>()(
  Schema.Struct({ status: Schema.Literal("ok") }),
) {}

export class ShutdownRequestContent extends Schema.Opaque<ShutdownRequestContent>()(
  Schema.Struct({ restart: Schema.Boolean }),
) {}

export class ShutdownReplyContent extends Schema.Opaque<ShutdownReplyContent>()(
  Schema.Struct({
    status: Schema.Literal("ok"),
    restart: Schema.Boolean,
  }),
) {}

export class StreamContent extends Schema.Opaque<StreamContent>()(
  Schema.Struct({
    name: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
) {}

export class DisplayContent extends Schema.Opaque<DisplayContent>()(
  Schema.Struct({
    data: MimeBundle,
    metadata: Schema.Json,
    transient: Schema.optionalKey(Schema.Json),
  }),
) {}

export class ErrorContent extends Schema.Opaque<ErrorContent>()(
  Schema.Struct({
    ename: Schema.String,
    evalue: Schema.String,
    traceback: Schema.Array(Schema.String),
  }),
) {}

export class ClearOutputContent extends Schema.Opaque<ClearOutputContent>()(
  Schema.Struct({ wait: Schema.Boolean }),
) {}

export class StatusContent extends Schema.Opaque<StatusContent>()(
  Schema.Struct({
    execution_state: Schema.Literals(["busy", "idle", "starting"]),
  }),
) {}

export class ExecuteReplyContent extends Schema.Opaque<ExecuteReplyContent>()(
  Schema.Struct({
    status: Schema.Literals(["ok", "error"]),
    execution_count: Schema.optionalKey(Schema.Finite),
    ename: Schema.optionalKey(Schema.String),
    evalue: Schema.optionalKey(Schema.String),
    traceback: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
) {}
