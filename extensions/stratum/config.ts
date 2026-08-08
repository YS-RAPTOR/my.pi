import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

const enabled = Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(true)),
);

export const schema = Schema.Struct({
  "better-skills": Schema.Struct({
    enabled,
    inline: enabled,
    gating: enabled,
    expansion: enabled,
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
