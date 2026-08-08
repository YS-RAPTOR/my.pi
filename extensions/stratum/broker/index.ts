import { NodeServices, NodeSocketServer } from "@effect/platform-node";
import { Effect, Layer, Option, Schema, Stream, pipe } from "effect";
import { Headers } from "effect/unstable/http";
import {
  Rpc,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/unstable/rpc";
import { rmSync } from "node:fs";
import { Activity } from "#s/capabilities/activity";
import { Heartbeat } from "#s/capabilities/heartbeat";
import { Shell } from "#s/capabilities/shell";
import { Connection } from "#s/common/connection";
import { Owner } from "#s/common/owner";
import { Session } from "#s/common/session";
import { Config } from "#s/config";

export type Options = Connection.Options;

const yieldAfterSeconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export class Wait extends Schema.Class<Wait, { readonly brand: unique symbol }>(
  "Resource.Wait",
)({
  resource_id: Shell.ResourceId,
  yield_after: yieldAfterSeconds,
}) {}

export class WaitSuccess extends Schema.Class<
  WaitSuccess,
  { readonly brand: unique symbol }
>("Resource.WaitSuccess")({
  completed: Schema.Boolean,
}) {}

export class SocketPathError extends Schema.TaggedErrorClass<
  SocketPathError,
  { readonly brand: unique symbol }
>("Stratum.SocketPathError")("SocketPathError", {
  path: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
}) {}

export const WaitRpc = Rpc.make("Resource.Wait", {
  payload: Wait,
  success: WaitSuccess,
  error: Shell.ResourceNotFound,
});

const WaitRpcs = RpcGroup.make(WaitRpc).middleware(Session.Middleware);

export const ClientMessage = Schema.Union([
  Activity.Changed,
  Heartbeat.Changed,
  Heartbeat.Triggered,
]);

export const WatchRpc = Rpc.make("Client.Watch", {
  success: ClientMessage,
  stream: true,
});

const WatchRpcs = RpcGroup.make(WatchRpc).middleware(Session.Middleware);

export const Rpcs = WatchRpcs.merge(WaitRpcs)
  .merge(Activity.Rpcs)
  .merge(Heartbeat.Rpcs)
  .merge(Shell.Rpcs);

const header = Effect.fn("Broker.__header")(function* (
  headers: Headers.Headers,
  name: string,
  reason: "missing-session" | "missing-token",
) {
  return yield* pipe(
    Headers.get(headers, name),
    Option.filter((value) => value.length > 0),
    Option.match({
      onNone: () => Effect.fail(new Session.Rejected({ reason })),
      onSome: Effect.succeed,
    }),
  );
});

const sessionLayer = (clientToken: string) =>
  Layer.succeed(
    Session.Middleware,
    Session.Middleware.of((effect, { headers }) =>
      pipe(
        header(headers, Session.IDHeader, "missing-session"),
        Effect.bindTo("id"),
        Effect.bind("token", () =>
          header(headers, Session.ClientTokenHeader, "missing-token"),
        ),
        Effect.filterOrFail(
          ({ token }) => token === clientToken,
          () => new Session.Rejected({ reason: "invalid-token" }),
        ),
        Effect.flatMap(({ id }) =>
          Effect.provideService(
            effect,
            Session.Current,
            Session.Current.of({
              id: new Session.ID({ value: id }),
            }),
          ),
        ),
      ),
    ),
  );

const waitHandlers = WaitRpcs.toLayer(
  Shell.Service.pipe(
    Effect.map((shell) => {
      const waits = { shell: shell.wait } as const;
      return WaitRpcs.of({
        "Resource.Wait": (request) =>
          Session.Current.pipe(
            Effect.flatMap((session) =>
              waits[request.resource_id.capability](
                session.id,
                request.resource_id,
                request.yield_after,
              ),
            ),
            Effect.map((completed) => new WaitSuccess({ completed })),
          ),
      });
    }),
  ),
);

const watchHandlers = WatchRpcs.toLayer(
  Effect.gen(function* () {
    const activity = yield* Activity.Service;
    const heartbeat = yield* Heartbeat.Service;
    return WatchRpcs.of({
      "Client.Watch": () =>
        Stream.unwrap(
          Session.Current.pipe(
            Effect.map(({ id }) => {
              const owner = Owner.make(`session:${id.value}`);
              return Stream.merge(
                activity.watch(owner),
                heartbeat.watch(owner),
              );
            }),
          ),
        ),
    });
  }),
);

const removeSocket = Effect.fn("Broker.__removeSocket")(function* (
  path: string,
) {
  return yield* Effect.try({
    try: () => rmSync(path, { force: true }),
    catch: (cause) =>
      new SocketPathError({
        path,
        message:
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Unable to prepare the broker socket",
      }),
  });
});

const socketLayer = (path: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* removeSocket(path);
      yield* Effect.addFinalizer(() => removeSocket(path).pipe(Effect.ignore));
      return NodeSocketServer.layer({ path });
    }),
  );

export const layer = (options: Options) => {
  const shell = pipe(
    Shell.layer,
    Layer.provide(Shell.Herdr.layer),
    Layer.provide(Shell.Stdio.layer),
    Layer.provide(Shell.Store.layer),
    Layer.provide(Config.layer),
    Layer.provide(NodeServices.layer),
  );

  const activity = Activity.layer;
  const heartbeat = Heartbeat.layer.pipe(Layer.provide(activity));
  const services = Layer.mergeAll(shell, activity, heartbeat);

  const handlers = pipe(
    Layer.mergeAll(
      Activity.handlers,
      Heartbeat.handlers,
      Shell.handlers,
      waitHandlers,
      watchHandlers,
    ),
    Layer.provide(services),
  );

  return pipe(
    RpcServer.layer(Rpcs, {
      concurrency: "unbounded",
      spanPrefix: "StratumBroker",
    }),
    Layer.provide(handlers),
    Layer.provide(sessionLayer(options.clientToken)),
    Layer.provideMerge(RpcServer.layerProtocolSocketServer),
    Layer.provideMerge(socketLayer(options.socketPath)),
    Layer.provide(RpcSerialization.layerNdjson),
  );
};

export const run = Effect.fn("Broker.run")(function* (options: Options) {
  return yield* Layer.launch(layer(options));
});

export * as Broker from "./index.ts";
