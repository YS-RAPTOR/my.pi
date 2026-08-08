import { Schema } from "effect";
import { Owner } from "#s/common/owner";

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export class Status extends Schema.brand("Heartbeat.Status")(
  Schema.Literals(["ACTIVE", "PAUSED"]),
) {}

export class Entry extends Schema.Class<
  Entry,
  { readonly brand: unique symbol }
>("Heartbeat.Entry")({
  owner: Owner,
  interval_seconds: positiveInt,
  instruction: Schema.NonEmptyString,
  expires_at: Schema.NullOr(nonNegativeInt),
  status: Status,
  next_run_at: Schema.NullOr(nonNegativeInt),
  last_run_at: Schema.NullOr(nonNegativeInt),
  created_at: nonNegativeInt,
  updated_at: nonNegativeInt,
}) {}

export class Start extends Schema.Class<
  Start,
  { readonly brand: unique symbol }
>("Heartbeat.Start")({
  owner: Owner,
  interval_seconds: positiveInt,
  instruction: Schema.NonEmptyString,
  expires_at: Schema.NullOr(nonNegativeInt),
}) {}

export class Get extends Schema.Class<Get, { readonly brand: unique symbol }>(
  "Heartbeat.Get",
)({
  owner: Owner,
}) {}

export class Stop extends Schema.Class<Stop, { readonly brand: unique symbol }>(
  "Heartbeat.Stop",
)({
  owner: Owner,
}) {}

export class Changed extends Schema.TaggedClass<
  Changed,
  { readonly brand: unique symbol }
>()("heartbeat_changed", {
  entry: Schema.NullOr(Entry),
}) {}

export class Triggered extends Schema.TaggedClass<
  Triggered,
  { readonly brand: unique symbol }
>()("heartbeat_triggered", {
  instruction: Schema.NonEmptyString,
}) {}
