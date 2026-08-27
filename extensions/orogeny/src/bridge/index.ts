import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  HashMap,
  Layer,
  Match,
  Option,
  Schema,
  Scope,
  SynchronizedRef,
  pipe,
} from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Bootstrap from "./prelude.ts";

const Request = Schema.Struct({
  notebookId: Schema.String,
  operation: Schema.String,
  input: Schema.Json,
});

const MAX_BODY_SIZE = FileSystem.Size(8 * 1024 * 1024);

export class Failed extends Data.TaggedError("BridgeFailed")<{
  readonly errorName: string;
  readonly message: string;
  readonly data: Option.Option<Schema.Json>;
}> {}

export type Handler = (input: Schema.Json) => Effect.Effect<unknown, unknown>;

export class Notebook extends Data.Class<{
  readonly bootstrap: string;
  readonly interrupt: Effect.Effect<void>;
}> {}

export type Interface = Readonly<{
  register: (name: string, handler: Handler) => Effect.Effect<void>;
  openNotebook: (id: string) => Effect.Effect<Notebook, never, Scope.Scope>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Bridge") {}

const errorBody = (status: number, name: string, message: string, data?: Schema.Json) =>
  HttpServerResponse.jsonUnsafe(
    {
      ok: false,
      error: data === undefined ? { name, message } : { name, message, data },
    },
    { status },
  );

type SerializedError = Readonly<{
  name: string;
  message: string;
  data: Schema.Json | undefined;
}>;

const errorFromCause = (cause: Cause.Cause<unknown>): SerializedError =>
  pipe(
    Match.value(Cause.squash(cause)),
    Match.when(Match.instanceOf(Failed), (error) => ({
      name: error.errorName,
      message: error.message,
      data: Option.getOrUndefined(error.data),
    })),
    Match.when(Match.instanceOf(Error), (error) => ({
      name: error.name,
      message: error.message,
      data: undefined,
    })),
    Match.orElse((error) => ({ name: "Error", message: String(error), data: undefined })),
  );

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const token = crypto.randomUUID();
    const url = HttpServer.formatAddress(server.address);
    const definitions = yield* SynchronizedRef.make(HashMap.empty<string, Handler>());
    const notebooks = yield* SynchronizedRef.make(
      HashMap.empty<string, FiberSet.FiberSet<Schema.Json, unknown>>(),
    );

    const register: Interface["register"] = Effect.fn("Orogeny.Bridge.register")(
      function* (name, handler) {
        yield* SynchronizedRef.updateEffect(definitions, (current) =>
          pipe(
            Match.value(HashMap.has(current, name)),
            Match.when(true, () =>
              Effect.die(
                new Cause.IllegalArgumentError(
                  `Bridge operation ${JSON.stringify(name)} is already registered`,
                ),
              ),
            ),
            Match.when(false, () => Effect.succeed(HashMap.set(current, name, handler))),
            Match.exhaustive,
          ),
        );
      },
    );

    const openNotebook: Interface["openNotebook"] = Effect.fn("Orogeny.Bridge.openNotebook")(
      function* (id) {
        const fibers = yield* FiberSet.make<Schema.Json, unknown>();
        yield* SynchronizedRef.updateEffect(notebooks, (current) =>
          pipe(
            Match.value(HashMap.has(current, id)),
            Match.when(true, () =>
              Effect.die(
                new Cause.IllegalArgumentError(
                  `Bridge notebook ${JSON.stringify(id)} is already open`,
                ),
              ),
            ),
            Match.when(false, () => Effect.succeed(HashMap.set(current, id, fibers))),
            Match.exhaustive,
          ),
        );
        yield* Effect.addFinalizer(() => SynchronizedRef.update(notebooks, HashMap.remove(id)));
        return new Notebook({
          bootstrap: Bootstrap.source(url, token, id),
          interrupt: FiberSet.clear(fibers),
        });
      },
    );

    const route = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method !== "POST" || request.url !== "/bridge")
        return errorBody(404, "NotFound", "Bridge endpoint not found.");
      if (request.headers.authorization !== `Bearer ${token}`)
        return errorBody(401, "Unauthorized", "Invalid bridge token.");

      const decoded = yield* pipe(
        HttpServerRequest.schemaBodyJson(Request),
        Effect.provideService(HttpServerRequest.MaxBodySize, MAX_BODY_SIZE),
        Effect.exit,
      );
      if (Exit.isFailure(decoded))
        return errorBody(400, "InvalidRequest", Cause.pretty(decoded.cause));

      const notebook = HashMap.get(yield* SynchronizedRef.get(notebooks), decoded.value.notebookId);
      if (Option.isNone(notebook))
        return errorBody(404, "NotebookNotFound", "Bridge notebook is not open.");

      const definition = HashMap.get(
        yield* SynchronizedRef.get(definitions),
        decoded.value.operation,
      );
      if (Option.isNone(definition))
        return errorBody(
          404,
          "OperationNotFound",
          `Bridge operation ${JSON.stringify(decoded.value.operation)} is not registered.`,
        );

      const fiber = yield* pipe(
        definition.value(decoded.value.input),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
        Effect.interruptible,
        Effect.forkChild({ startImmediately: false }),
      );
      yield* FiberSet.add(notebook.value, fiber);
      const result = yield* Fiber.await(fiber);
      return Exit.match(result, {
        onFailure: (cause) => {
          const error = errorFromCause(cause);
          return errorBody(500, error.name, error.message, error.data);
        },
        onSuccess: (value) => HttpServerResponse.jsonUnsafe({ ok: true, value }),
      });
    });

    yield* server.serve(route);
    return Service.of({ register, openNotebook });
  }),
);

export * as Bootstrap from "./prelude.ts";
export * as Bridge from "./index.ts";
