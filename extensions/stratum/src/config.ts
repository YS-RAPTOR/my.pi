import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Config as EffectConfig, Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

const enabled = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));
const string = (fallback: string) =>
  Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(fallback)));
const positiveInteger = (fallback: number) =>
  Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );
const nonNegativeInteger = (fallback: number) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );
const percentage = (fallback: number) =>
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

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
  commands: Schema.Struct({
    enabled,
    stretch: Schema.Struct({
      enabled,
      "step-tokens": positiveInteger(64_000),
      "max-context-tokens": positiveInteger(896_000),
    }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  rewriters: Schema.Struct({
    enabled,
    clarify: enabled,
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
  search: Schema.Struct({
    enabled,
    "frecency-database-path": string("~/.local/state/fff/frecency"),
    "history-database-path": string("~/.local/state/fff/history"),
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

export class Service extends Context.Service<Service, Value>()("stratum/Config") {}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const home = yield* EffectConfig.string("HOME");
    const file = paths.join(getAgentDir(), "stratum.json");
    const exists = yield* files.exists(file);
    const source = exists ? yield* files.readFileString(file) : "{}";
    const value = yield* decode(source);
    const resolveHome = (path: string) =>
      path === "~" ? home : path.startsWith("~/") ? paths.join(home, path.slice(2)) : path;
    return Service.of({
      ...value,
      search: {
        ...value.search,
        "frecency-database-path": resolveHome(value.search["frecency-database-path"]),
        "history-database-path": resolveHome(value.search["history-database-path"]),
      },
    });
  }),
);

export * as Config from "./config.ts";
