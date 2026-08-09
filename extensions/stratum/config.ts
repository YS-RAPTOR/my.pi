import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

const enabled = Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(true)),
);
const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveWithDefault = (value: number) =>
  positiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(value)));
const nonNegativeWithDefault = (value: number) =>
  nonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

export const schema = Schema.Struct({
  "better-skills": Schema.Struct({
    enabled,
    inline: enabled,
    gating: enabled,
    expansion: enabled,
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  shell: Schema.Struct({
    stdio: Schema.Struct({
      stdinCapacity: positiveWithDefault(16),
    }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    herdr: Schema.Struct({
      requestTimeoutMillis: positiveWithDefault(2_000),
      requestRetries: nonNegativeWithDefault(3),
      requestRetryMillis: nonNegativeWithDefault(50),
      maximumMessageBytes: positiveWithDefault(1024 * 1024),
      startupAttempts: positiveWithDefault(100),
      startupPollMillis: nonNegativeWithDefault(50),
      shutdownTimeoutMillis: positiveWithDefault(3_000),
      waitPollMillis: positiveWithDefault(100),
      descriptorTokenBytes: positiveWithDefault(24),
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
