import { Schema } from "effect";

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class Owner extends Schema.brand("Activity.Owner")(
  Schema.TemplateLiteral([
    Schema.NonEmptyString,
    ":",
    Schema.NonEmptyString,
  ]),
) {}

export class ID extends Schema.brand("Activity.ID")(Schema.NonEmptyString) {}

export class Claim extends Schema.Class<
  Claim,
  { readonly brand: unique symbol }
>("Activity.Claim")({
  owner: Owner,
  id: ID,
  reason: Schema.NonEmptyString,
  started_at: nonNegativeInt,
}) {}

export class Activate extends Schema.Class<
  Activate,
  { readonly brand: unique symbol }
>("Activity.Activate")({
  owner: Owner,
  id: ID,
  reason: Schema.NonEmptyString,
}) {}

export class Release extends Schema.Class<
  Release,
  { readonly brand: unique symbol }
>("Activity.Release")({
  owner: Owner,
  id: ID,
}) {}

export class ReleaseOwner extends Schema.Class<
  ReleaseOwner,
  { readonly brand: unique symbol }
>("Activity.ReleaseOwner")({
  owner: Owner,
}) {}

export class Snapshot extends Schema.Class<
  Snapshot,
  { readonly brand: unique symbol }
>("Activity.Snapshot")({
  claims: Schema.Array(Claim),
}) {}

export class Changed extends Schema.TaggedClass<
  Changed,
  { readonly brand: unique symbol }
>()("activity_changed", {
  snapshot: Snapshot,
}) {}
