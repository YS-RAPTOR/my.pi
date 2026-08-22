import { NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  pipe,
  PlatformError,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Config } from "#o/config";
import { Jupyter } from "#o/jupyter";
import { Notebook } from "#o/notebook";
import { CellOutput } from "#o/output";
import { Prelude } from "#o/prelude";

export class OperationFailed extends Data.TaggedError("OrogenySession")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type StartEvent = Pi.Hooks.Barriers.BarrierOf<"session_start">;

export type Interface = Readonly<{
  start: (
    event: StartEvent,
    sessionFile: Option.Option<string>,
  ) => Effect.Effect<void, OperationFailed>;
  stop: Effect.Effect<void>;
  notebook: Effect.Effect<Notebook.Interface, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Session") {}

class Active extends Data.Class<{
  readonly notebook: Notebook.Interface;
  readonly scope: Scope.Closeable;
}> {}

const DIRECTORY = { recursive: true, mode: 0o700 } as const;

const optionalNotFound = <Value, Requirements>(
  effect: Effect.Effect<Value, PlatformError.PlatformError, Requirements>,
) =>
  pipe(
    effect,
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
  );

const notebookLayer = (
  artifactRoot: string,
  config: Config.Value,
  prelude: Prelude.Interface,
) =>
  pipe(
    Notebook.layer(
      new Notebook.Config({
        artifactRoot,
        maxLiveNotebooks: config["max-live-notebooks"],
        maxWaitMillis: config["max-wait-ms"],
        interruptGraceMillis: config["interrupt-grace-ms"],
      }),
    ),
    Layer.provide(Jupyter.layer),
    Layer.provide(CellOutput.layer),
    Layer.provide(Layer.succeed(Prelude.Service, prelude)),
    Layer.provide(NodeServices.layer),
  );

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const config = yield* Config.Service;
    const prelude = yield* Prelude.Service;
    const barriers = yield* Pi.Hooks.Barriers.Service;
    const rootScope = yield* Effect.scope;
    const active = yield* SynchronizedRef.make(Option.none<Active>());

    const stop: Interface["stop"] = pipe(
      Effect.gen(function* () {
        const current = yield* SynchronizedRef.getAndSet(active, Option.none());
        if (Option.isSome(current)) yield* Scope.close(current.value.scope, Exit.void);
      }),
      Effect.withSpan("Orogeny.Session.stop"),
    );

    const inherit = Effect.fn("Orogeny.Session.inherit")(function* (
      parentFile: string,
      childRoot: string,
    ) {
      const parentRoot = `${parentFile}.orogeny`;
      const entries = yield* pipe(
        files.readDirectory(parentRoot),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
      );
      const ids = Arr.filterMap(entries, (entry) =>
        Schema.decodeUnknownResult(Notebook.NotebookId)(entry),
      );

      yield* Effect.forEach(
        ids,
        (id) =>
          Effect.gen(function* () {
            const canonical = yield* optionalNotFound(files.realPath(paths.join(parentRoot, id)));
            if (Option.isNone(canonical)) return;

            const info = yield* optionalNotFound(files.stat(canonical.value));
            if (Option.isNone(info)) return;
            if (info.value.type !== "Directory" || paths.basename(canonical.value) !== id)
              return yield* new OperationFailed({
                operation: "inherit notebook",
                message: `Invalid canonical artifact for ${id}: ${canonical.value}`,
              });

            const source = yield* optionalNotFound(
              files.readFileString(paths.join(canonical.value, "notebook.jsonl")),
            );
            if (Option.isNone(source)) return;
            yield* Schema.decodeUnknownEffect(Notebook.NotebookJournal)(
              source.value.trimEnd().split("\n"),
            );

            const link = paths.join(childRoot, id);
            const created = yield* pipe(
              files.symlink(paths.relative(childRoot, canonical.value), link),
              Effect.as(true),
              Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
            );
            if (created) return;

            yield* files.readLink(link);
            const existing = yield* files.realPath(link);
            if (existing !== canonical.value)
              return yield* new OperationFailed({
                operation: "inherit notebook",
                message: `Conflicting child artifact: ${link}`,
              });
          }),
        { discard: true },
      );
    });

    const start: Interface["start"] = Effect.fn("Orogeny.Session.start")(
      function* (event, sessionFile) {
        yield* stop;
        const scope = yield* Scope.fork(rootScope, "sequential");
        const opened = yield* pipe(
          Effect.gen(function* () {
            const artifactRoot = Option.isSome(sessionFile)
              ? `${sessionFile.value}.orogeny`
              : yield* files.makeTempDirectoryScoped({ prefix: "orogeny-" });
            yield* files.makeDirectory(artifactRoot, DIRECTORY);
            if (
              event.reason === "fork" &&
              event.previousSessionFile !== undefined &&
              Option.isSome(sessionFile)
            )
              yield* inherit(event.previousSessionFile, artifactRoot);

            const context = yield* Layer.buildWithScope(
              notebookLayer(artifactRoot, config, prelude),
              scope,
            );
            return new Active({
              notebook: Context.get(context, Notebook.Service),
              scope,
            });
          }),
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
          Effect.mapError(
            (cause) =>
              new OperationFailed({
                operation: "start Orogeny session",
                message: String(cause),
              }),
          ),
        );
        yield* SynchronizedRef.set(active, Option.some(opened));
      },
    );

    const notebook: Interface["notebook"] = pipe(
      SynchronizedRef.get(active),
      Effect.flatMap((current) =>
        Effect.fromOption(
          () =>
            new OperationFailed({
              operation: "use Orogeny session",
              message: "The Orogeny session has not started",
            }),
        )(Option.map(current, (value) => value.notebook)),
      ),
    );

    yield* barriers.handle(
      "session_start",
      Effect.fn("Orogeny.Session.onStart")(function* (event) {
        const callback = yield* Pi.Host.Callback;
        yield* pipe(start(event, yield* callback.session.file), Effect.orDie);
      }),
    );
    yield* barriers.handle("session_shutdown", () => stop);
    yield* Effect.addFinalizer(() => stop);

    return Service.of({ start, stop, notebook });
  }),
);

export * as Session from "./session.ts";
