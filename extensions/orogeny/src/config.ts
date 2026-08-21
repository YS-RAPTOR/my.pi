import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

const positiveInteger = (fallback: number) =>
  Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export const schema = Schema.Struct({
  "max-live-notebooks": positiveInteger(5),
  "max-wait-ms": positiveInteger(5 * 60 * 1_000),
  "interrupt-grace-ms": positiveInteger(5_000),
});

export type Value = typeof schema.Type;

export class Service extends Context.Service<Service, Value>()("orogeny/Config") {}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const file = paths.join(getAgentDir(), "orogeny.json");
    const source = (yield* files.exists(file)) ? yield* files.readFileString(file) : "{}";
    return Service.of(yield* decode(source));
  }),
);

export * as Config from "./config.ts";
