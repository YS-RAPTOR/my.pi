import { Schema } from "effect";

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const snapshotLines = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(1_000),
);

export class Driver extends Schema.brand("Shell.Driver")(
  Schema.Literals(["pty", "herdr", "stdio"]),
) {}

export class ResourceId extends Schema.Class<
  ResourceId,
  { readonly brand: unique symbol }
>("Shell.ResourceId")({
  value: Schema.TemplateLiteral([
    "shell:",
    Schema.toEncoded(Driver),
    ":",
    positiveInt,
  ]),
}) {
  get capability(): "shell" {
    return "shell";
  }

  get driver(): typeof Driver.Type {
    if (this.value.startsWith("shell:pty:")) return Driver.make("pty");
    if (this.value.startsWith("shell:herdr:")) return Driver.make("herdr");
    return Driver.make("stdio");
  }
}

export class Lifecycle extends Schema.brand("Shell.Lifecycle")(
  Schema.TaggedUnion({
    running: {},
    draining: {
      exit_code: Schema.NullOr(Schema.Int),
      signal: Schema.NullOr(Schema.NonEmptyString),
    },
    completed: {
      exit_code: Schema.NullOr(Schema.Int),
      signal: Schema.NullOr(Schema.NonEmptyString),
    },
    failed: {
      message: Schema.NonEmptyString,
    },
  }),
) {}

export class ResourceSummary extends Schema.Class<
  ResourceSummary,
  { readonly brand: unique symbol }
>("Shell.ResourceSummary")({
  resource_id: ResourceId,
  cmd: Schema.String,
  cwd: Schema.NonEmptyString,
  workspace: Schema.optionalKey(Schema.NonEmptyString),
  lifecycle: Lifecycle,
  output_file: Schema.optionalKey(Schema.NonEmptyString),
  started_at: nonNegativeInt,
  last_interaction: nonNegativeInt,
}) {}

export class ResourceNotFound extends Schema.TaggedErrorClass<
  ResourceNotFound,
  { readonly brand: unique symbol }
>("Shell.ResourceNotFound")("ResourceNotFound", {
  resource_id: ResourceId,
}) {}

export class Open extends Schema.Class<Open, { readonly brand: unique symbol }>(
  "Shell.Open",
)({
  cmd: Schema.String,
  cwd: Schema.NonEmptyString,
  env: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  ),
  pty: Schema.optionalKey(Schema.Boolean),
}) {}

export class OpenSuccess extends Schema.Class<
  OpenSuccess,
  { readonly brand: unique symbol }
>("Shell.OpenSuccess")({
  resource_id: ResourceId,
  output_file: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export class OpenFailed extends Schema.TaggedErrorClass<
  OpenFailed,
  { readonly brand: unique symbol }
>("Shell.OpenFailed")("OpenFailed", {
  message: Schema.NonEmptyString,
}) {}

export class PtyUnavailable extends Schema.TaggedErrorClass<
  PtyUnavailable,
  { readonly brand: unique symbol }
>("Shell.PtyUnavailable")("PtyUnavailable", {
  message: Schema.NonEmptyString,
}) {}

export class Snapshot extends Schema.Class<
  Snapshot,
  { readonly brand: unique symbol }
>("Shell.Snapshot")({
  resource_id: ResourceId,
  lines: Schema.NullOr(snapshotLines),
}) {}

export class TerminalSnapshot extends Schema.Class<
  TerminalSnapshot,
  { readonly brand: unique symbol }
>("Shell.TerminalSnapshot")({
  resource_id: ResourceId,
  text: Schema.String,
  revision: nonNegativeInt,
  truncated: Schema.Boolean,
  lifecycle: Lifecycle,
}) {}

export class SnapshotUnavailable extends Schema.TaggedErrorClass<
  SnapshotUnavailable,
  { readonly brand: unique symbol }
>("Shell.SnapshotUnavailable")("SnapshotUnavailable", {
  resource_id: ResourceId,
}) {}

export class SnapshotFailed extends Schema.TaggedErrorClass<
  SnapshotFailed,
  { readonly brand: unique symbol }
>("Shell.SnapshotFailed")("SnapshotFailed", {
  resource_id: ResourceId,
  message: Schema.NonEmptyString,
}) {}

export class List extends Schema.Class<List, { readonly brand: unique symbol }>(
  "Shell.List",
)({
  active: Schema.optionalKey(Schema.Boolean),
}) {}

export class ListSuccess extends Schema.Class<
  ListSuccess,
  { readonly brand: unique symbol }
>("Shell.ListSuccess")({
  resources: Schema.Array(ResourceSummary),
}) {}

export class Inspect extends Schema.Class<
  Inspect,
  { readonly brand: unique symbol }
>("Shell.Inspect")({
  resource_id: ResourceId,
}) {}

export class Write extends Schema.Class<
  Write,
  { readonly brand: unique symbol }
>("Shell.Write")({
  resource_id: ResourceId,
  text: Schema.NonEmptyString,
}) {}

export class StdinClosed extends Schema.TaggedErrorClass<
  StdinClosed,
  { readonly brand: unique symbol }
>("Shell.StdinClosed")("StdinClosed", {
  resource_id: ResourceId,
}) {}

export class CloseStdin extends Schema.Class<
  CloseStdin,
  { readonly brand: unique symbol }
>("Shell.CloseStdin")({
  resource_id: ResourceId,
}) {}

export class CloseStdinUnavailable extends Schema.TaggedErrorClass<
  CloseStdinUnavailable,
  { readonly brand: unique symbol }
>("Shell.CloseStdinUnavailable")("CloseStdinUnavailable", {
  resource_id: ResourceId,
}) {}

export class Signal extends Schema.Class<
  Signal,
  { readonly brand: unique symbol }
>("Shell.Signal")({
  resource_id: ResourceId,
  signal: Schema.NonEmptyString,
}) {}

export class SignalFailed extends Schema.TaggedErrorClass<
  SignalFailed,
  { readonly brand: unique symbol }
>("Shell.SignalFailed")("SignalFailed", {
  resource_id: ResourceId,
  message: Schema.NonEmptyString,
}) {}
