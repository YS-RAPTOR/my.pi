import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  FileFinder,
  type FileFinderApi,
  type MixedItem,
  type Result,
} from "@ff-labs/fff-node";
import {
  Array as Arr,
  Config as EffectConfig,
  Data,
  Effect,
  Layer,
  Match,
  Option,
  SynchronizedRef,
  pipe,
} from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Config } from "#s/config";

const SCAN_TIMEOUT_MS = 15_000;

class HomeAutocompleteFailed extends Data.TaggedError("HomeAutocompleteFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const completionItems = (items: ReadonlyArray<MixedItem>): Array<AutocompleteItem> =>
  pipe(
    items,
    Arr.take(20),
    Arr.map((mixed) => {
      const path = mixed.item.relativePath;
      const quoted = path.includes(" ") ? `"${path}"` : path;
      return {
        value: `~/${quoted}`,
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

const fromResult = <Value>(operation: string, result: Result<Value>) =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(
        new HomeAutocompleteFailed({ message: `${operation} failed: ${result.error}` }),
      );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = (yield* Config.Service).commands["home-autocomplete"];
    const home = yield* EffectConfig.string("HOME");
    const barriers = yield* Pi.Hooks.Barriers.Service;
    const finder = yield* SynchronizedRef.make<Option.Option<FileFinderApi>>(Option.none());
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

    const destroy = (value: FileFinderApi) =>
      Effect.sync(() => {
        if (!value.isDestroyed) value.destroy();
      }).pipe(Effect.ignore);

    const create = Effect.fn("Features.Commands.HomeAutocomplete.create")(function* () {
      const options = {
        basePath: home,
        aiMode: true,
        enableFsRootScanning: false,
        enableHomeDirScanning: true,
      } as const;
      const withDatabases = FileFinder.create({
        ...options,
        frecencyDbPath: config["frecency-database-path"],
        historyDbPath: config["history-database-path"],
      });
      const opened = withDatabases.ok ? withDatabases : FileFinder.create(options);
      const value = yield* fromResult("Home autocomplete initialization", opened);

      yield* pipe(
        Effect.tryPromise({
          try: () => value.waitForScan(SCAN_TIMEOUT_MS),
          catch: (error) =>
            new HomeAutocompleteFailed({
              message: `Home autocomplete scan failed: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            }),
        }),
        Effect.flatMap((result) => fromResult("Home autocomplete scan", result)),
        Effect.onError(() => destroy(value)),
      );
      return value;
    });

    const acquire = Effect.fn("Features.Commands.HomeAutocomplete.acquire")(function* (
      onAcquire: Effect.Effect<void>,
    ) {
      return yield* SynchronizedRef.modifyEffect(finder, (current) =>
        pipe(
          current,
          Option.match({
            onNone: () =>
              Effect.gen(function* () {
                yield* onAcquire;
                const value = yield* create();
                return [value, Option.some(value)] as const;
              }),
            onSome: (value) => Effect.succeed([value, current] as const),
          }),
        ),
      );
    });

    yield* barriers.handle(
      "session_start",
      Effect.fn("Features.Commands.HomeAutocomplete.sessionStarted")(function* () {
        const callback = yield* Pi.Host.Callback;
        yield* callback.ui.addAutocompleteProvider((current) => ({
          triggerCharacters: [
            ...new Set([...(current.triggerCharacters ?? []), "~"]),
          ],
          async getSuggestions(lines, line, column, options) {
            const prefix =
              (lines[line] ?? "")
                .slice(0, column)
                .match(/(?:^|[ \t])(~(?:"[^"]*|[^\s]*))$/)?.[1] ?? null;
            if (prefix === null || options.signal.aborted) {
              return current.getSuggestions(lines, line, column, options);
            }

            const query = prefix.slice(1).replace(/^\/?"?/, "");
            const fallback = Effect.tryPromise(() =>
              current.getSuggestions(lines, line, column, options),
            );
            const lookup = pipe(
              acquire(
                callback.ui.notify(
                  "Indexing your home directory for ~ autocomplete. This initial scan may take a while.",
                  "warning",
                ),
              ),
              Effect.flatMap((value) =>
                fromResult(
                  "Home autocomplete",
                  value.mixedSearch(query, { pageSize: 20 }),
                ),
              ),
            );
            return runPromise(
              pipe(
                lookup,
                Effect.map((result) => completionItems(result.items)),
                Effect.filterOrFail((items) => items.length > 0),
                Effect.map((items) => ({ prefix, items })),
                Effect.catch(() => fallback),
              ),
              { signal: options.signal },
            );
          },
          applyCompletion(lines, line, column, item, prefix) {
            if (!prefix.startsWith("~")) {
              return current.applyCompletion(lines, line, column, item, prefix);
            }
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
        }));
      }),
    );

    yield* Effect.addFinalizer(() =>
      pipe(
        SynchronizedRef.get(finder),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: destroy,
          }),
        ),
      ),
    );
  }),
);

export * as HomeAutocomplete from "./home-autocomplete.ts";
