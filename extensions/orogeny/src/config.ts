import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { CodeTheme } from "./ui/code-theme.ts";

const positiveInteger = (fallback: number) =>
  Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

const cacheDirectory = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "orogeny",
  "tree-sitter",
);
const parserDirectory = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  process.env.NVIM_APPNAME ?? "nvim",
  "site",
  "parser",
);

export const schema = Schema.Struct({
  "max-live-notebooks": positiveInteger(5),
  "push-wait-ms": positiveInteger(1_000),
  "max-wait-ms": positiveInteger(5 * 60 * 1_000),
  "interrupt-grace-ms": positiveInteger(5_000),
  "tree-sitter": Schema.Struct({
    "cache-directory": Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed(cacheDirectory)),
    ),
    "parser-directories": Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([parserDirectory])),
    ),
    languages: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed(["typescript"])),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  syntax: Schema.Struct({
    theme: CodeTheme.schema.pipe(
      Schema.withDecodingDefault(Effect.succeed(CodeTheme.tokyoNightMoon)),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
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
