import {
  Chunk,
  Context,
  Data,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Semaphore,
  pipe,
} from "effect";
import type { Target } from "./tmux.ts";

export class Metadata extends Data.Class<{
  readonly resourceId: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
}> {}

export class Inspection extends Data.Class<{
  readonly resourceId: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly isRunning: boolean;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}> {}

export class ResourceNotFound extends Data.TaggedError("ResourceNotFound")<{
  readonly resourceId: string;
}> {}

export class OperationFailed extends Data.TaggedError(
  "ShellStoreOperationFailed",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export class CompletionArtifact extends Data.Class<{
  readonly inspection: Inspection;
  readonly visible: string;
  readonly history: string;
}> {}

export type Resource = Data.TaggedEnum<{
  running: {
    readonly metadata: Metadata;
    readonly target: Target;
  };
  completed: {
    readonly metadata: Metadata;
    readonly artifactPath: string;
  };
}>;

export const Resource = Data.taggedEnum<Resource>();

export type Running = Extract<Resource, { readonly _tag: "running" }>;
export type Completed = Extract<Resource, { readonly _tag: "completed" }>;

export type Interface = Readonly<{
  register: (metadata: Metadata, target: Target) => Effect.Effect<Running>;
  get: (resourceId: string) => Effect.Effect<Resource, ResourceNotFound>;
  entries: Effect.Effect<Chunk.Chunk<Resource>>;
  complete: (
    resource: Running,
    inspection: Inspection,
    visible: string,
    history: string,
  ) => Effect.Effect<Completed, OperationFailed>;
  artifact: (
    resource: Completed,
  ) => Effect.Effect<CompletionArtifact, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Shell.Store",
) {}

const messageFrom = (cause: unknown): string =>
  cause instanceof globalThis.Error ? cause.message : String(cause);

const ArtifactPayload = Schema.Struct({
  inspection: Schema.Struct({
    resourceId: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    startedAt: Schema.Finite,
    isRunning: Schema.Boolean,
    exitCode: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    signal: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  visible: Schema.String,
  history: Schema.String,
});

const decodeArtifact = Schema.decodeUnknownSync(
  Schema.fromJsonString(ArtifactPayload),
);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const directoryLock = yield* Semaphore.make(1);
    const artifactDirectory = yield* Ref.make<Option.Option<string>>(
      Option.none(),
    );
    const resources = yield* Ref.make<HashMap.HashMap<string, Resource>>(
      HashMap.empty(),
    );

    const directory = Effect.fn("Shell.Store.__directory")(function* () {
      return yield* directoryLock.withPermit(
        Effect.gen(function* () {
          const existing = yield* Ref.get(artifactDirectory);
          if (Option.isSome(existing)) return existing.value;
          const created = yield* pipe(
            files.makeTempDirectory({ prefix: "stratum-shell-" }),
            Effect.tap((path) => files.chmod(path, 0o700)),
            Effect.mapError(
              (cause) =>
                new OperationFailed({
                  operation: "create shell artifact directory",
                  message: messageFrom(cause),
                }),
            ),
          );
          yield* Ref.set(artifactDirectory, Option.some(created));
          return created;
        }),
      );
    });

    const register: Interface["register"] = Effect.fn("Shell.Store.register")(
      function* (metadata, target) {
        const resource = Resource.running({ metadata, target });
        yield* Ref.update(
          resources,
          HashMap.set<string, Resource>(metadata.resourceId, resource),
        );
        return resource;
      },
    );

    const get: Interface["get"] = Effect.fn("Shell.Store.get")(
      function* (resourceId) {
        const resource = HashMap.get(yield* Ref.get(resources), resourceId);
        if (Option.isSome(resource)) return resource.value;
        return yield* new ResourceNotFound({ resourceId });
      },
    );

    const entries: Interface["entries"] = pipe(
      Ref.get(resources),
      Effect.map((current) => Chunk.fromIterable(HashMap.values(current))),
      Effect.withSpan("Shell.Store.entries"),
    );

    const artifact: Interface["artifact"] = Effect.fn("Shell.Store.artifact")(
      function* (resource) {
        return yield* pipe(
          files.readFileString(resource.artifactPath),
          Effect.flatMap((source) =>
            Effect.try({
              try: () => {
                const decoded = decodeArtifact(source);
                return new CompletionArtifact({
                  inspection: new Inspection(decoded.inspection),
                  visible: decoded.visible,
                  history: decoded.history,
                });
              },
              catch: (cause) =>
                new OperationFailed({
                  operation: "decode completed shell artifact",
                  message: messageFrom(cause),
                }),
            }),
          ),
          Effect.mapError((cause) =>
            Predicate.isTagged(cause, "ShellStoreOperationFailed")
              ? cause
              : new OperationFailed({
                  operation: "read completed shell artifact",
                  message: messageFrom(cause),
                }),
          ),
        );
      },
    );

    const complete: Interface["complete"] = Effect.fn("Shell.Store.complete")(
      function* (resource, inspection, visible, history) {
        const current = HashMap.get(
          yield* Ref.get(resources),
          resource.metadata.resourceId,
        );
        if (
          Option.isSome(current) &&
          Resource.$is("completed")(current.value)
        ) {
          return current.value;
        }

        const root = yield* directory();
        const artifactPath = paths.join(
          root,
          `${resource.metadata.resourceId}.json`,
        );
        const temporaryPath = `${artifactPath}.${globalThis.crypto.randomUUID()}.tmp`;
        const value = new CompletionArtifact({ inspection, visible, history });
        yield* pipe(
          files.writeFileString(temporaryPath, JSON.stringify(value), {
            flag: "wx",
            mode: 0o600,
          }),
          Effect.andThen(files.rename(temporaryPath, artifactPath)),
          Effect.mapError(
            (cause) =>
              new OperationFailed({
                operation: "write completed shell artifact",
                message: messageFrom(cause),
              }),
          ),
        );

        const completed = Resource.completed({
          metadata: resource.metadata,
          artifactPath,
        });
        yield* Ref.update(
          resources,
          HashMap.set<string, Resource>(
            resource.metadata.resourceId,
            completed,
          ),
        );
        return completed;
      },
    );

    return Service.of({ register, get, entries, complete, artifact });
  }),
);

export * as Store from "./store.ts";
