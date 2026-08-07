import { Context, Schema } from "effect";
import { RpcMiddleware } from "effect/unstable/rpc";

export class ID extends Schema.Class<ID, { readonly brand: unique symbol }>(
  "Stratum.SessionId",
)({
  value: Schema.NonEmptyString,
}) {}

export const IDHeader = "x-stratum-session-id";
export const ClientTokenHeader = "x-stratum-client-token";

export type CurrentValue = Readonly<{
  id: ID;
}>;

export class Current extends Context.Service<Current, CurrentValue>()(
  "stratum/CurrentSession",
) {}

export class Rejected extends Schema.TaggedErrorClass<
  Rejected,
  { readonly brand: unique symbol }
>("Stratum.SessionRejected")("SessionRejected", {
  reason: Schema.Literals([
    "missing-session",
    "invalid-session",
    "missing-token",
    "invalid-token",
  ]),
}) {}

export class Middleware extends RpcMiddleware.Service<
  Middleware,
  { provides: Current }
>()("stratum/SessionMiddleware", {
  error: Rejected,
}) {}

export * as Session from "./session.ts";
