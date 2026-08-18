import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

const enabled = Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(true)),
);
const positiveInteger = (fallback: number) =>
  Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );
const nonNegativeInteger = (fallback: number) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );
const percentage = (fallback: number) =>
  Schema.Finite.check(
    Schema.isBetween({ minimum: 0, maximum: 100 }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(fallback)));

export const schema = Schema.Struct({
  activity: Schema.Struct({
    enabled,
    "terminal-reporting": enabled,
    "inhibit-command": Schema.String.pipe(
      Schema.withDecodingDefault(
        Effect.succeed(
          "systemd-inhibit --what=sleep --mode=block --who='Stratum Pi' --why='Pi agent active' sleep infinity",
        ),
      ),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  "better-skills": Schema.Struct({
    enabled,
    inline: enabled,
    gating: enabled,
    expansion: enabled,
    "command-timeout-ms": positiveInteger(10_000),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  shell: Schema.Struct({
    enabled,
    "default-wait-timeout-seconds": nonNegativeInteger(30),
    "max-read-lines": positiveInteger(2_000),
    terminal: Schema.Struct({
      columns: positiveInteger(175),
      rows: positiveInteger(75),
      "history-lines": positiveInteger(100_000),
    }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  footer: Schema.Struct({
    enabled,
    cwd: enabled,
    model: enabled,
    tokens: enabled,
    cache: enabled,
    cost: enabled,
    statuses: enabled,
    context: Schema.Struct({
      enabled,
      "warning-percent": percentage(70),
      "error-percent": percentage(90),
    }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    runway: Schema.Struct({
      enabled,
      "request-timeout-ms": positiveInteger(15_000),
      "refresh-interval-ms": positiveInteger(30_000),
      "cached-failure-limit": nonNegativeInteger(5),
    }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});

export type Value = typeof schema.Type;

export class Service extends Context.Service<Service, Value>()(
  "stratum/Config",
) {}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const file = paths.join(getAgentDir(), "stratum.json");
    const exists = yield* files.exists(file);
    const source = exists ? yield* files.readFileString(file) : "{}";
    return Service.of(yield* decode(source));
  }),
);

export * as Config from "./config.ts";
