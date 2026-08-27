import type {
  FileFinderApi,
  GrepCursor,
  GrepMode,
  GrepResult,
  HealthCheck,
  MixedSearchResult,
  Result,
  SearchResult,
} from "@ff-labs/fff-node";
import {
  Array as Arr,
  Clock,
  Config as EffectConfig,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Predicate,
  Ref,
  Schema,
  String as Str,
  SynchronizedRef,
  pipe,
} from "effect";
import { Config } from "#s/config";
import { Fff } from "./fff.ts";
import { buildQuery, rootCovers, routePathConstraint } from "./query.ts";

const SCAN_TIMEOUT_MS = 15_000;
const GREP_TIME_BUDGET_MS = 10_000;
const MAX_AUXILIARY_FINDERS = 3;
const AUXILIARY_IDLE_MS = 5 * 60 * 1_000;
const CURSOR_LIMIT = 200;
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;
const WILDCARD_ONLY =
  /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const parseRegex = Option.liftThrowable((pattern: string) => new RegExp(pattern));

const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const nonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const FindInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optionalKey(Schema.String),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  limit: Schema.optionalKey(positiveInteger),
  cursor: Schema.optionalKey(Schema.String),
});
export type FindInput = typeof FindInput.Type;

export class FindOutput extends Data.Class<{
  readonly result: SearchResult;
  readonly pattern: string;
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly nextCursor?: string;
}> {}

export const GrepInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optionalKey(Schema.String),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(nonNegativeInteger),
  limit: Schema.optionalKey(positiveInteger),
  cursor: Schema.optionalKey(Schema.String),
});
export type GrepInput = typeof GrepInput.Type;

const decodeFind = Schema.decodeUnknownEffect(FindInput, { onExcessProperty: "error" });
const decodeGrep = Schema.decodeUnknownEffect(GrepInput, { onExcessProperty: "error" });

export class GrepOutput extends Data.Class<{
  readonly result: GrepResult;
  readonly fuzzyFallback: boolean;
  readonly nextCursor?: string;
}> {}

export class SearchFailed extends Data.TaggedError("SearchFailed")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type SearchError = SearchFailed;

type FinderEntry = Readonly<{
  root: string;
  finder: FileFinderApi;
  lastUsed: number;
}>;

type Selection = Readonly<{
  entry: FinderEntry;
  query: string;
  auxiliaryRoot: string | undefined;
}>;

type Cursor = Data.TaggedEnum<{
  Find: {
    readonly id: string;
    readonly query: string;
    readonly pattern: string;
    readonly pageSize: number;
    readonly nextPageIndex: number;
    readonly auxiliaryRoot: string | undefined;
  };
  Grep: {
    readonly id: string;
    readonly cursor: GrepCursor;
  };
}>;

const Cursor = Data.taggedEnum<Cursor>();
type FindCursor = ReturnType<typeof Cursor.Find>;
type CursorState = Readonly<{ next: number; entries: ReadonlyArray<Cursor> }>;

export type Interface = Readonly<{
  initialize: (cwd: string) => Effect.Effect<void, SearchError>;
  find: (input: Schema.Json) => Effect.Effect<FindOutput, SearchError>;
  grep: (input: Schema.Json) => Effect.Effect<GrepOutput, SearchError>;
  completeWorkspace: (query: string) => Effect.Effect<MixedSearchResult, SearchError>;
  completeHome: (
    query: string,
    onAcquire?: Effect.Effect<void>,
  ) => Effect.Effect<MixedSearchResult, SearchError>;
  health: Effect.Effect<HealthCheck, SearchError>;
  rescan: Effect.Effect<void, SearchError>;
}>;

export class Service extends Context.Service<Service, Interface>()("stratum/Features.Search") {}

const failure = (operation: string, error: Error | string) =>
  new SearchFailed({
    operation,
    message: error instanceof Error ? error.message : error,
  });

const fromResult = <Value>(operation: string, result: Result<Value>) => {
  if (result.ok) return Effect.succeed(result.value);
  return Effect.fail(failure(operation, result.error));
};

const evaluate = <Value>(
  operation: string,
  thunk: () => Result<Value>,
): Effect.Effect<Value, SearchFailed> =>
  pipe(
    Effect.try({
      try: thunk,
      catch: (error) => failure(operation, error instanceof Error ? error : String(error)),
    }),
    Effect.flatMap((result) => fromResult(operation, result)),
    Effect.withSpan(`Features.Search.${operation}`),
  );

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fff = yield* Fff.Service;
    const config = (yield* Config.Service).search;
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const home = paths.resolve(yield* EffectConfig.string("HOME"));
    const workspace = yield* SynchronizedRef.make<Option.Option<FinderEntry>>(Option.none());
    const auxiliary = yield* SynchronizedRef.make<ReadonlyArray<FinderEntry>>([]);
    const cursors = yield* SynchronizedRef.make<CursorState>({ next: 0, entries: [] });
    const databasesEnabled = yield* Ref.make(true);
    const resolveRoute = (pathConstraint: string | undefined, cwd: string) =>
      pipe(
        routePathConstraint(pathConstraint, cwd, home),
        Effect.provideService(FileSystem.FileSystem, files),
        Effect.provideService(Path.Path, paths),
      );

    const destroy = (finder: FileFinderApi) =>
      pipe(
        Effect.sync(() => {
          if (!finder.isDestroyed) finder.destroy();
        }),
        Effect.ignore,
      );

    const create = Effect.fn("Features.Search.__create")(function* (root: string) {
      const options = {
        basePath: root,
        aiMode: true,
        enableFsRootScanning: false,
        enableHomeDirScanning: true,
      } as const;
      const databaseOptions = {
        ...options,
        frecencyDbPath: config["frecency-database-path"],
        historyDbPath: config["history-database-path"],
      };
      const withDatabases = yield* Ref.get(databasesEnabled);
      const first = yield* Effect.sync(() => fff.create(withDatabases ? databaseOptions : options));
      const retry = pipe(
        Ref.set(databasesEnabled, false),
        Effect.andThen(Effect.sync(() => fff.create(options))),
      );
      const opened = first.ok || !withDatabases ? first : yield* retry;
      if (!opened.ok) return yield* failure("create", opened.error);

      const finder = opened.value;
      yield* pipe(
        Effect.tryPromise({
          try: () => finder.waitForScan(SCAN_TIMEOUT_MS),
          catch: (error) => failure("scan", error instanceof Error ? error : String(error)),
        }),
        Effect.flatMap((result) => fromResult("scan", result)),
        Effect.onError(() => destroy(finder)),
      );
      return finder;
    });

    const initialize: Interface["initialize"] = Effect.fn("Features.Search.initialize")(
      function* (cwd) {
        const root = paths.resolve(cwd);
        yield* SynchronizedRef.modifyEffect(workspace, (current) =>
          Effect.gen(function* () {
            const initialized = pipe(
              current,
              Option.exists((entry) => entry.root === root && !entry.finder.isDestroyed),
            );
            if (initialized) return [undefined, current] as const;

            const finder = yield* create(root);
            yield* pipe(
              current,
              Option.map((entry) => destroy(entry.finder)),
              Option.getOrElse(() => Effect.void),
            );
            return [
              undefined,
              Option.some({ root, finder, lastUsed: yield* Clock.currentTimeMillis }),
            ];
          }),
        );
      },
    );

    const workspaceEntry = Effect.fn("Features.Search.__workspace")(() =>
      pipe(
        SynchronizedRef.get(workspace),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failure("search", "Search has not been initialized")),
            onSome: (entry) => Effect.succeed(entry),
          }),
        ),
      ),
    );

    const acquireAuxiliary = Effect.fn("Features.Search.__acquireAuxiliary")(function* (
      root: string,
      exact = false,
      onAcquire: Effect.Effect<void> = Effect.void,
    ) {
      return yield* SynchronizedRef.modifyEffect(auxiliary, (current) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const stale = pipe(
            current,
            Arr.filter((entry) => now - entry.lastUsed > AUXILIARY_IDLE_MS),
          );
          const active = pipe(
            current,
            Arr.filter((entry) => now - entry.lastUsed <= AUXILIARY_IDLE_MS),
          );
          yield* Effect.forEach(stale, (entry) => destroy(entry.finder), { discard: true });

          const reusable = pipe(
            active,
            Arr.filter((entry) => !entry.finder.isDestroyed),
            Arr.filter((entry) =>
              exact ? entry.root === root : rootCovers(paths, entry.root, root),
            ),
            Arr.sortWith((entry) => entry.root.length, Order.flip(Order.Number)),
          )[0];

          if (reusable !== undefined) {
            const refreshed = { ...reusable, lastUsed: now };
            return [
              refreshed,
              pipe(
                active,
                Arr.map((entry) => (entry === reusable ? refreshed : entry)),
              ),
            ];
          }

          yield* onAcquire;
          const finder = yield* create(root);
          const oldest = pipe(
            active,
            Arr.sortWith((entry) => entry.lastUsed, Order.Number),
          )[0];
          const evicted = active.length >= MAX_AUXILIARY_FINDERS ? oldest : undefined;
          const retained = pipe(
            Option.fromUndefinedOr(evicted),
            Option.map((entry) =>
              pipe(
                active,
                Arr.filter((candidate) => candidate !== entry),
              ),
            ),
            Option.getOrElse(() => active),
          );
          if (evicted !== undefined) yield* destroy(evicted.finder);

          const entry = { root, finder, lastUsed: now };
          return [entry, pipe(retained, Arr.append(entry))] as const;
        }),
      );
    });

    const storeCursor = Effect.fn("Features.Search.__storeCursor")(function* (
      make: (id: string) => Cursor,
    ) {
      return yield* SynchronizedRef.modify(cursors, (current) => {
        const next = current.next + 1;
        const id = `search_c${next}`;
        const entries = pipe(current.entries, Arr.append(make(id)), Arr.takeRight(CURSOR_LIMIT));
        return [id, { next, entries }] as const;
      });
    });

    const getCursor = Effect.fn("Features.Search.__getCursor")((id: string) =>
      pipe(
        SynchronizedRef.get(cursors),
        Effect.map((current) =>
          pipe(
            current.entries,
            Arr.findFirst((entry) => entry.id === id),
          ),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failure("cursor", `Unknown or expired cursor: ${id}`)),
            onSome: (cursor) => Effect.succeed(cursor),
          }),
        ),
      ),
    );

    const getFindCursor = Effect.fn("Features.Search.__getFindCursor")(function* (id: string) {
      const cursor = yield* getCursor(id);
      if (!Predicate.isTagged(cursor, "Find")) {
        return yield* failure("cursor", `Invalid find cursor: ${id}`);
      }
      return cursor;
    });

    const getGrepCursor = Effect.fn("Features.Search.__getGrepCursor")(function* (id: string) {
      const cursor = yield* getCursor(id);
      if (!Predicate.isTagged(cursor, "Grep")) {
        return yield* failure("cursor", `Invalid grep cursor: ${id}`);
      }
      return cursor;
    });

    const routed = Effect.fn("Features.Search.__routed")(function* (
      pathConstraint: string | undefined,
      pattern: string,
      exclude: string | ReadonlyArray<string> | undefined,
    ) {
      const main = yield* workspaceEntry();
      const route = yield* resolveRoute(pathConstraint, main.root);
      if (route === null) {
        return {
          entry: main,
          query: buildQuery(paths, pathConstraint, pattern, exclude, main.root),
          auxiliaryRoot: undefined,
        };
      }

      const entry = yield* acquireAuxiliary(route.root);
      const rebased = paths.relative(entry.root, route.root).replaceAll(paths.sep, "/");
      const suffix = pipe([rebased, route.suffix], Arr.filter(Str.isNonEmpty), Arr.join("/"));
      return {
        entry,
        query: buildQuery(paths, suffix || undefined, pattern, exclude, entry.root),
        auxiliaryRoot: entry.root,
      };
    });

    const resumeFind = Effect.fn("Features.Search.__resumeFind")(function* (
      cursor: FindCursor,
    ): Effect.fn.Return<Selection, SearchError> {
      const entry =
        cursor.auxiliaryRoot === undefined
          ? yield* workspaceEntry()
          : yield* acquireAuxiliary(cursor.auxiliaryRoot, true);
      return { entry, query: cursor.query, auxiliaryRoot: cursor.auxiliaryRoot };
    });

    const find: Interface["find"] = Effect.fn("Features.Search.find")(function* (raw) {
      const input = yield* pipe(
        decodeFind(raw),
        Effect.mapError((error) => failure("find", `Invalid arguments: ${error.message}`)),
      );
      const resumed = input.cursor === undefined ? undefined : yield* getFindCursor(input.cursor);
      const selected =
        resumed === undefined
          ? yield* routed(input.path, input.pattern, input.exclude)
          : yield* resumeFind(resumed);
      const pattern = resumed?.pattern ?? input.pattern;
      const query = selected.query;
      const pageSize = resumed?.pageSize ?? Math.max(1, input.limit ?? 30);
      const pageIndex = resumed?.nextPageIndex ?? 0;
      const result = yield* evaluate<SearchResult>("find", () =>
        selected.entry.finder.fileSearch(query, { pageIndex, pageSize }),
      );
      const shown = pageIndex * pageSize + result.items.length;
      const nextCursor =
        result.items.length >= pageSize && result.totalMatched > shown
          ? yield* storeCursor((id) =>
              Cursor.Find({
                id,
                query,
                pattern,
                pageSize,
                nextPageIndex: pageIndex + 1,
                auxiliaryRoot: selected.auxiliaryRoot,
              }),
            )
          : undefined;
      const output = { result, pattern, pageIndex, pageSize };
      return nextCursor === undefined
        ? new FindOutput(output)
        : new FindOutput({ ...output, nextCursor });
    });

    const grep: Interface["grep"] = Effect.fn("Features.Search.grep")(function* (raw) {
      const input = yield* pipe(
        decodeGrep(raw),
        Effect.mapError((error) => failure("grep", `Invalid arguments: ${error.message}`)),
      );
      const selected = yield* routed(input.path, input.pattern, input.exclude);
      const hasRegexSyntax = REGEX_SYNTAX.test(input.pattern);
      const mode: GrepMode =
        hasRegexSyntax && Option.isSome(parseRegex(input.pattern)) ? "regex" : "plain";
      const pattern = input.pattern.trim();
      if (hasRegexSyntax && WILDCARD_ONLY.test(pattern)) {
        return yield* failure(
          "grep",
          `Pattern ${JSON.stringify(input.pattern)} matches everything; use a concrete substring or identifier.`,
        );
      }

      const pageSize = Math.min(Math.max(1, input.limit ?? 20), 50);
      const context = Math.min(Math.max(0, Math.floor(input.context ?? 0)), 20);
      const cursor =
        input.cursor === undefined ? null : (yield* getGrepCursor(input.cursor)).cursor;
      const options = {
        mode,
        smartCase: input.caseSensitive !== true,
        maxMatchesPerFile: pageSize,
        pageSize,
        cursor,
        beforeContext: context,
        afterContext: context,
        classifyDefinitions: true,
        timeBudgetMs: GREP_TIME_BUDGET_MS,
      } as const;
      const exact = yield* evaluate<GrepResult>("grep", () =>
        selected.entry.finder.grep(selected.query, options),
      );
      const shouldTryFuzzy =
        exact.items.length === 0 &&
        exact.nextCursor === null &&
        cursor === null &&
        mode !== "regex";
      const fuzzy = yield* pipe(
        evaluate<GrepResult>("grep", () => {
          const finalSegment = input.path?.split(/[\\/]/).at(-1) ?? "";
          const query = FILE_EXTENSION.test(finalSegment) ? input.pattern : selected.query;
          return selected.entry.finder.grep(query, {
            ...options,
            mode: "fuzzy",
            cursor: null,
            beforeContext: 0,
            afterContext: 0,
          });
        }),
        Effect.when(Effect.succeed(shouldTryFuzzy)),
        Effect.map(Option.filter((result) => result.items.length > 0)),
      );
      const result = Option.getOrElse(fuzzy, () => exact);
      const fuzzyFallback = Option.isSome(fuzzy);
      const continuation = result.nextCursor;
      const nextCursor =
        continuation === null
          ? undefined
          : yield* storeCursor((id) => Cursor.Grep({ id, cursor: continuation }));
      const output = { result, fuzzyFallback };
      return nextCursor === undefined
        ? new GrepOutput(output)
        : new GrepOutput({ ...output, nextCursor });
    });

    const complete = Effect.fn("Features.Search.__complete")((entry: FinderEntry, query: string) =>
      evaluate("autocomplete", () => entry.finder.mixedSearch(query, { pageSize: 20 })),
    );

    const completeWorkspace: Interface["completeWorkspace"] = Effect.fn(
      "Features.Search.completeWorkspace",
    )((query) =>
      pipe(
        workspaceEntry(),
        Effect.flatMap((entry) => complete(entry, query)),
      ),
    );

    const completeHome: Interface["completeHome"] = Effect.fn("Features.Search.completeHome")(
      (query, onAcquire = Effect.void) =>
        pipe(
          acquireAuxiliary(home, false, onAcquire),
          Effect.flatMap((entry) => complete(entry, query)),
        ),
    );

    const health: Interface["health"] = pipe(
      workspaceEntry(),
      Effect.flatMap((entry) => evaluate("health", () => entry.finder.healthCheck())),
    );

    const rescan: Interface["rescan"] = pipe(
      workspaceEntry(),
      Effect.flatMap((entry) => evaluate("rescan", () => entry.finder.scanFiles())),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const main = pipe(
          yield* SynchronizedRef.get(workspace),
          Option.map((entry) => entry.finder),
          Arr.fromOption,
        );
        const finders = pipe(
          yield* SynchronizedRef.get(auxiliary),
          Arr.map((entry) => entry.finder),
          Arr.appendAll(main),
        );
        yield* Effect.forEach(finders, destroy, { discard: true });
      }),
    );

    return Service.of({
      initialize,
      find,
      grep,
      completeWorkspace,
      completeHome,
      health,
      rescan,
    });
  }),
);

export * as SearchService from "./service.ts";
