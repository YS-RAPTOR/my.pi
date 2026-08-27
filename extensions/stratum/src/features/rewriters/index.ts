import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Array as Arr, Data, Effect, Exit, HashMap, Layer, Match, pipe } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import * as Registry from "./register.ts";

class RewriteFailed extends Data.TaggedError("RewriteFailed")<{
  readonly message: string;
}> {}

const TOKEN = /(?<!\S)(\\?)::([A-Za-z][A-Za-z0-9_-]*)(?=$|\s|[.,;:!?…])/g;

const parse = (input: string) => {
  const matches = Array.from(input.matchAll(TOKEN));
  const names = matches.flatMap((match) =>
    match[1] === "\\" || match[2] === undefined ? [] : [match[2]],
  );
  const text = input.replace(TOKEN, (_token, escaped: string, name: string) =>
    escaped === "\\" ? `::${name}` : "",
  );
  return { matched: matches.length > 0, names, text: text.trim() };
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* Registry.Service;
    const barriers = yield* Pi.Hooks.Barriers.Service;
    const interceptors = yield* Pi.Hooks.Interceptors.Service;

    yield* barriers.handle(
      "session_start",
      Effect.fn("Features.Rewriters.autocomplete")(function* () {
        const callback = yield* Pi.Host.Callback;
        const registrations = yield* registry.list;
        yield* callback.ui.addAutocompleteProvider((current) => ({
          triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ":"])],
          getSuggestions(lines, line, column, options) {
            const prefix = (lines[line] ?? "").slice(0, column).split(/\s/).at(-1);
            if (prefix?.startsWith(":") !== true) {
              return current.getSuggestions(lines, line, column, options);
            }
            const query = prefix.replace(/^::?/, "").toLowerCase();
            const items = pipe(
              registrations,
              Arr.filter(({ name, definition }) =>
                `${name} ${definition.description}`.toLowerCase().includes(query),
              ),
              Arr.map(({ name, definition }) => ({
                value: `::${name}`,
                label: `::${name}`,
                description: definition.description,
              })),
            );
            return Promise.resolve(items.length === 0 ? null : { prefix, items });
          },
          applyCompletion: current.applyCompletion.bind(current),
        }));
      }),
    );

    yield* interceptors.handle(
      "input",
      -10,
      Effect.fn("Features.Rewriters.input")(function* (event) {
        if (event.source === "extension") return { action: "continue" as const };

        const parsed = parse(event.text);
        if (!parsed.matched) return { action: "continue" as const };
        if (parsed.names.length === 0) {
          const result = { action: "transform" as const, text: parsed.text };
          return event.images === undefined ? result : { ...result, images: event.images };
        }

        const callback = yield* Pi.Host.Callback;
        const context = yield* Pi.Host.CallbackContext;
        const registrations = yield* registry.list;
        const byName = HashMap.fromIterable(
          registrations.map((registration) => [registration.name, registration]),
        );
        const unknown = parsed.names.filter((name) => !HashMap.has(byName, name));
        if (unknown.length > 0) {
          yield* callback.ui.notify(`Unknown rewriters: ${unknown.join(", ")}.`, "error");
          return { action: "handled" as const };
        }

        const invocation = {
          mode: context.mode,
          model: context.model,
          modelRegistry: context.modelRegistry,
          signal: context.signal,
        };
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const execute = (
          def: Registry.Definition,
          input: string,
        ): Effect.Effect<string | null, RewriteFailed> => {
          const rewrite = pipe(
            def.rewrite(input, invocation),
            Effect.mapError(() => new RewriteFailed({ message: def.errorMessage })),
          );
          if (context.mode !== "tui") return rewrite;

          return pipe(
            Effect.tryPromise({
              try: () =>
                context.ui.custom<Exit.Exit<string | null, RewriteFailed> | null>(
                  (tui, theme, _keybindings, done) => {
                    const loader = new BorderedLoader(tui, theme, def.loadingMessage);
                    loader.onAbort = () => {
                      done(null);
                      context.ui.setEditorText(event.text);
                    };
                    void runPromise(Effect.exit(rewrite), { signal: loader.signal }).then(
                      done,
                      () => done(null),
                    );
                    return loader;
                  },
                ),
              catch: () => new RewriteFailed({ message: def.errorMessage }),
            }),
            Effect.flatMap((result) => {
              if (result === null) return Effect.succeed(null);
              return Exit.match(result, {
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (value) => Effect.succeed(value),
              });
            }),
          );
        };

        const rewritten = yield* pipe(
          Effect.reduce(
            parsed.names,
            (): string | null => parsed.text,
            (input, name) =>
              pipe(
                Match.value(input),
                Match.when(null, () => Effect.succeed(null)),
                Match.orElse((text) => execute(HashMap.getUnsafe(byName, name).definition, text)),
              ),
          ),
          Effect.catchTag("RewriteFailed", ({ message }) =>
            pipe(callback.ui.notify(message, "error"), Effect.as(null)),
          ),
        );
        if (rewritten === null) return { action: "handled" as const };

        if (!(yield* callback.ui.available)) {
          const result = { action: "transform" as const, text: rewritten };
          return event.images === undefined ? result : { ...result, images: event.images };
        }
        yield* callback.ui.setEditorText(rewritten);
        return { action: "handled" as const };
      }),
    );
  }),
);

export * as Clarify from "./clarify.ts";
export * as Register from "./register.ts";
export * as Rewriters from "./index.ts";
