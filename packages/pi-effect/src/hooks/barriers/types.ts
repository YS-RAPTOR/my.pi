import { Schema } from "effect";

export class SessionStartEvent extends Schema.Opaque<SessionStartEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_start"),
    reason: Schema.Literals(["startup", "reload", "new", "resume", "fork"]),
    previousSessionFile: Schema.optionalKey(Schema.String),
  }),
) {}

export class SessionShutdownEvent extends Schema.Opaque<SessionShutdownEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_shutdown"),
    reason: Schema.Literals(["quit", "reload", "new", "resume", "fork"]),
    targetSessionFile: Schema.optionalKey(Schema.String),
  }),
) {}

export class AfterProviderResponseEvent extends Schema.Opaque<AfterProviderResponseEvent>()(
  Schema.Struct({
    type: Schema.Literal("after_provider_response"),
    status: Schema.Finite,
    headers: Schema.Record(Schema.String, Schema.String),
  }),
) {}

export const Barrier = Schema.Union([
  SessionStartEvent,
  SessionShutdownEvent,
  AfterProviderResponseEvent,
]);
