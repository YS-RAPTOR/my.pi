import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { MixedItem } from "@ff-labs/fff-node";
import { Array as Arr, Effect, Layer, Match, Option, pipe } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Config } from "#s/config";
import * as Search from "./service.ts";

const completionItems = (
  marker: "@" | "~",
  items: ReadonlyArray<MixedItem>,
): Array<AutocompleteItem> =>
  pipe(
    items,
    Arr.take(20),
    Arr.map((mixed) => {
      const path = mixed.item.relativePath;
      const quoted = path.includes(" ") ? `"${path}"` : path;
      return {
        value: pipe(
          Match.value(marker),
          Match.when("@", () => `@${quoted}`),
          Match.when("~", () => `~/${quoted}`),
          Match.exhaustive,
        ),
        label: pipe(
          Match.value(mixed),
          Match.when({ type: "file" }, ({ item }) => item.fileName),
          Match.when({ type: "directory" }, ({ item }) => item.dirName),
          Match.exhaustive,
        ),
        description: path,
      };
    }),
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const search = yield* Search.Service;
    const config = (yield* Config.Service).search;
    const barriers = yield* Pi.Hooks.Barriers.Service;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const triggerCharacters = pipe(
      [
        config.projectAutocomplete ? Option.some("@") : Option.none(),
        config.homeAutocomplete ? Option.some("~") : Option.none(),
      ],
      Arr.getSomes,
    );

    yield* barriers.handle(
      "session_start",
      Effect.fn("Features.Search.Autocomplete.sessionStarted")(function* () {
        if (triggerCharacters.length === 0) return;
        const callback = yield* Pi.Host.Callback;
        const context = yield* Pi.Host.CallbackContext;
        yield* pipe(
          search.initialize(context.cwd),
          Effect.andThen(
            callback.ui.addAutocompleteProvider((current) => ({
              triggerCharacters: [
                ...new Set([...(current.triggerCharacters ?? []), ...triggerCharacters]),
              ],
              async getSuggestions(lines, line, column, options) {
                const prefix =
                  (lines[line] ?? "")
                    .slice(0, column)
                    .match(/(?:^|[ \t])((?:@|~)(?:"[^"]*|[^\s]*))$/)?.[1] ?? null;
                if (prefix === null || options.signal.aborted) {
                  return current.getSuggestions(lines, line, column, options);
                }
                const marker = prefix.startsWith("@") ? "@" : "~";
                const enabled = pipe(
                  Match.value(marker),
                  Match.when("@", () => config.projectAutocomplete),
                  Match.orElse(() => config.homeAutocomplete),
                );
                if (!enabled) return current.getSuggestions(lines, line, column, options);
                const query = prefix.slice(1).replace(/^\/?"?/, "");
                const fallback = Effect.tryPromise(() =>
                  current.getSuggestions(lines, line, column, options),
                );
                const lookup = pipe(
                  Match.value(marker),
                  Match.when("@", () => search.completeWorkspace(query)),
                  Match.orElse(() =>
                    search.completeHome(
                      query,
                      callback.ui.notify(
                        "Search is indexing your home directory for ~ autocomplete. This initial scan may take a while.",
                        "warning",
                      ),
                    ),
                  ),
                );
                return runPromise(
                  pipe(
                    lookup,
                    Effect.map((result) => completionItems(marker, result.items)),
                    Effect.filterOrFail((items) => items.length > 0),
                    Effect.map((items) => ({ prefix, items })),
                    Effect.catch(() => fallback),
                  ),
                  { signal: options.signal },
                );
              },
              applyCompletion(lines, line, column, item, prefix) {
                const enabled =
                  (config.projectAutocomplete && prefix.startsWith("@")) ||
                  (config.homeAutocomplete && prefix.startsWith("~"));
                if (!enabled) return current.applyCompletion(lines, line, column, item, prefix);
                const currentLine = lines[line] ?? "";
                const next = `${currentLine.slice(0, column - prefix.length)}${item.value}${currentLine.slice(column)}`;
                return {
                  lines: [...lines.slice(0, line), next, ...lines.slice(line + 1)],
                  cursorLine: line,
                  cursorCol: column - prefix.length + item.value.length,
                };
              },
              shouldTriggerFileCompletion(lines, line, column) {
                return current.shouldTriggerFileCompletion?.(lines, line, column) ?? true;
              },
            })),
          ),
          Effect.catch((error) =>
            callback.ui.notify(`Search initialization failed: ${error.message}`, "error"),
          ),
        );
      }),
    );
  }),
);

export * as Autocomplete from "./autocomplete.ts";
