import {
  createBashToolDefinition,
  createReadToolDefinition,
  type BashToolInput,
  type ExtensionContext,
  type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { applyPatch } from "@ys-raptor/splice";
import { Search } from "@ys-raptor/stratum.pi";
import { Array as Arr, Context, Effect, Layer, Option, Ref, Schema, Scope, pipe } from "effect";
import { Value } from "typebox/value";
import { Bridge } from "#o/bridge";

const decodePatch = Schema.decodeUnknownEffect(Schema.String);

export type Interface = Readonly<{
  open: (context: ExtensionContext) => Effect.Effect<void, Search.SearchError, Scope.Scope>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Pi") {}

const failed = (errorName: string, message: string) =>
  new Bridge.Failed({ errorName, message, data: Option.none() });

const messageFrom = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const status = (item: {
  readonly gitStatus: string;
  readonly totalFrecencyScore?: number;
  readonly accessFrecencyScore?: number;
}): string | null => {
  if (item.gitStatus !== "" && item.gitStatus !== "clean" && item.gitStatus !== "unknown")
    return `${item.gitStatus} in git`;
  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= 25) return "VERY often touched file";
  if (frecency >= 20) return "often touched file";
  return null;
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bridge = yield* Bridge.Service;
    const search = yield* Search.Service;
    const context = yield* Ref.make(Option.none<ExtensionContext>());
    const current = (errorName: string) =>
      pipe(
        Ref.get(context),
        Effect.flatMap(
          Effect.fromOption(() => failed(errorName, "The notebook session is unavailable.")),
        ),
      );

    yield* bridge.register(
      "pi.applyPatch",
      Effect.fn("Orogeny.Pi.applyPatch")(function* (input) {
        const patch = yield* pipe(
          decodePatch(input),
          Effect.mapError(() => failed("PiApplyPatchError", "Invalid patch. Expected a string.")),
        );
        const active = yield* current("PiApplyPatchError");
        yield* Effect.tryPromise({
          try: () => applyPatch(patch, { cwd: active.cwd }),
          catch: (cause) => failed("PiApplyPatchError", messageFrom(cause)),
        });
      }),
    );

    yield* bridge.register(
      "pi.bash",
      Effect.fn("Orogeny.Pi.bash")(function* (input) {
        const active = yield* current("PiBashError");
        const definition = createBashToolDefinition(active.cwd);
        if (!Value.Check(definition.parameters, input))
          return yield* failed(
            "PiBashError",
            "Invalid arguments. Expected: pi.bash({ command, timeout? }).",
          );

        const result = yield* Effect.tryPromise({
          try: (signal) =>
            definition.execute(
              `orogeny-bash-${crypto.randomUUID()}`,
              // SAFETY: the definition's TypeBox schema accepted input above.
              input as BashToolInput,
              signal,
              undefined,
              active,
            ),
          catch: (cause) => failed("PiBashError", messageFrom(cause)),
        });
        const text = pipe(
          result.content,
          Arr.filter((content) => content.type === "text"),
          Arr.map((content) => content.text),
          Arr.join("\n"),
        );
        const truncation = result.details?.truncation;
        if (truncation?.truncated !== true) return { text, truncated: false, outputPath: null };

        const outputPath = result.details?.fullOutputPath;
        if (outputPath === undefined)
          return yield* failed(
            "PiBashError",
            "Bash output was truncated without a complete-output path.",
          );

        return { text: truncation.content, truncated: true, outputPath };
      }),
    );

    yield* bridge.register(
      "pi.find",
      Effect.fn("Orogeny.Pi.find")(function* (input) {
        const result = yield* pipe(
          search.find(input),
          Effect.mapError((error) => failed("PiFindError", error.message)),
        );
        return {
          paths: pipe(
            result.result.items,
            Arr.map((item) => item.relativePath),
          ),
          cursor: pipe(result.nextCursor, Option.fromUndefinedOr, Option.getOrNull),
        };
      }),
    );

    yield* bridge.register(
      "pi.grep",
      Effect.fn("Orogeny.Pi.grep")(function* (input) {
        const result = yield* pipe(
          search.grep(input),
          Effect.mapError((error) => failed("PiGrepError", error.message)),
        );
        return {
          matches: pipe(
            result.result.items,
            Arr.map((item) => ({
              path: item.relativePath,
              line: item.lineNumber,
              status: status(item),
              match: item.lineContent,
              text: pipe(
                item.contextBefore ?? [],
                Arr.append(item.lineContent),
                Arr.appendAll(item.contextAfter ?? []),
                Arr.join("\n"),
              ),
            })),
          ),
          fuzzy: result.fuzzyFallback,
          cursor: pipe(result.nextCursor, Option.fromUndefinedOr, Option.getOrNull),
        };
      }),
    );

    yield* bridge.register(
      "pi.read",
      Effect.fn("Orogeny.Pi.read")(function* (input) {
        const active = yield* current("PiReadError");
        const definition = createReadToolDefinition(active.cwd);
        if (!Value.Check(definition.parameters, input))
          return yield* failed(
            "PiReadError",
            "Invalid arguments. Expected: pi.read({ path, offset?, limit? }).",
          );

        const result = yield* Effect.tryPromise({
          try: (signal) =>
            definition.execute(
              `orogeny-read-${crypto.randomUUID()}`,
              // SAFETY: the definition's TypeBox schema accepted input above.
              input as ReadToolInput,
              signal,
              undefined,
              active,
            ),
          catch: (cause) => failed("PiReadError", messageFrom(cause)),
        });
        const text = pipe(
          result.content,
          Arr.filter((content) => content.type === "text"),
          Arr.map((content) => content.text),
          Arr.join("\n"),
        );
        const image = pipe(
          result.content,
          Arr.filter((content) => content.type === "image"),
          Arr.head,
          Option.map(({ data, mimeType }) => ({ data, mimeType })),
          Option.getOrNull,
        );
        const truncation = result.details?.truncation;
        return {
          text: truncation?.truncated === true ? truncation.content : text,
          truncated: truncation?.truncated === true,
          image,
        };
      }),
    );

    const open: Interface["open"] = Effect.fn("Orogeny.Pi.open")(function* (active) {
      yield* search.initialize(active.cwd);
      yield* Ref.set(context, Option.some(active));
      yield* Effect.addFinalizer(() => Ref.set(context, Option.none()));
    });

    return Service.of({ open });
  }),
);

export * as Prelude from "./prelude.ts";
export * as PiTools from "./index.ts";
