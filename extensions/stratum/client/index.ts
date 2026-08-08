import { NodeSocket } from "@effect/platform-node";
import { Context, Effect, Layer, pipe, Schema, Stream } from "effect";
import path from "node:path";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Broker } from "#s/broker";
import { Heartbeat } from "#s/capabilities/heartbeat";
import { Shell } from "#s/capabilities/shell";
import { Connection } from "#s/common/connection";
import { Session } from "#s/common/session";

export type Options = Connection.Options & Readonly<{ sessionId: Session.ID }>;

const ShellOpenInput = Shell.Open.mapFields((fields) => ({
  ...fields,
  cwd: Schema.optionalKey(fields.cwd),
}));

const ShellSnapshotInput = Shell.Snapshot.mapFields((fields) => ({
  ...fields,
  lines: Schema.optionalKey(fields.lines),
}));

export type Interface = Readonly<{
  heartbeatStart: (
    request: typeof Heartbeat.StartPayload.Type,
  ) => Effect.Effect<
    Heartbeat.Entry,
    Session.Rejected | RpcClientError
  >;
  heartbeatGet: Effect.Effect<
    Heartbeat.Entry | null,
    Session.Rejected | RpcClientError
  >;
  heartbeatStop: Effect.Effect<void, Session.Rejected | RpcClientError>;
  watch: Stream.Stream<
    typeof Broker.ClientMessage.Type,
    Session.Rejected | RpcClientError
  >;
  shellOpen: (
    request: typeof ShellOpenInput.Type,
  ) => Effect.Effect<
    Shell.OpenSuccess,
    Shell.OpenFailed | Shell.PtyUnavailable | Session.Rejected | RpcClientError
  >;
  shellSnapshot: (
    request: typeof ShellSnapshotInput.Type,
  ) => Effect.Effect<
    Shell.TerminalSnapshot,
    | Shell.ResourceNotFound
    | Shell.SnapshotUnavailable
    | Shell.SnapshotFailed
    | Session.Rejected
    | RpcClientError
  >;
  wait: (
    request: Broker.Wait,
  ) => Effect.Effect<
    Broker.WaitSuccess,
    Shell.ResourceNotFound | Session.Rejected | RpcClientError
  >;
  shellList: (
    request: Shell.List,
  ) => Effect.Effect<Shell.ListSuccess, Session.Rejected | RpcClientError>;
  shellInspect: (
    request: Shell.Inspect,
  ) => Effect.Effect<
    Shell.ResourceSummary,
    Shell.ResourceNotFound | Session.Rejected | RpcClientError
  >;
  shellWrite: (
    request: Shell.Write,
  ) => Effect.Effect<
    void,
    | Shell.ResourceNotFound
    | Shell.StdinClosed
    | Session.Rejected
    | RpcClientError
  >;
  shellCloseStdin: (
    request: Shell.CloseStdin,
  ) => Effect.Effect<
    void,
    | Shell.ResourceNotFound
    | Shell.CloseStdinUnavailable
    | Session.Rejected
    | RpcClientError
  >;
  shellSignal: (
    request: Shell.Signal,
  ) => Effect.Effect<
    void,
    | Shell.ResourceNotFound
    | Shell.SignalFailed
    | Session.Rejected
    | RpcClientError
  >;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Client",
) {}

export const layer = (options: Options) =>
  pipe(
    Layer.effect(
      Service,
      Effect.gen(function* () {
        const rpc = yield* RpcClient.make(Broker.Rpcs, {
          spanPrefix: "StratumClient",
        });
        const headers = {
          [Session.IDHeader]: options.sessionId.value,
          [Session.ClientTokenHeader]: options.clientToken,
        };
        const heartbeatStart: Interface["heartbeatStart"] = Effect.fn(
          "Client.heartbeatStart",
        )(function* (request) {
          return yield* rpc["Heartbeat.Start"](request, { headers });
        });
        const heartbeatGet: Interface["heartbeatGet"] = rpc[
          "Heartbeat.Get"
        ](undefined, { headers });
        const heartbeatStop: Interface["heartbeatStop"] = rpc[
          "Heartbeat.Stop"
        ](undefined, { headers });
        const watch: Interface["watch"] = rpc["Client.Watch"](undefined, {
          headers,
        });
        const shellOpen: Interface["shellOpen"] = Effect.fn("Client.shellOpen")(
          function* (request) {
            return yield* rpc["Shell.Open"](
              new Shell.Open({
                ...request,
                cwd: path.resolve(request.cwd ?? "."),
              }),
              { headers },
            );
          },
        );
        const shellSnapshot: Interface["shellSnapshot"] = Effect.fn(
          "Client.shellSnapshot",
        )(function* (request) {
          return yield* rpc["Shell.Snapshot"](
            new Shell.Snapshot({
              ...request,
              lines: request.lines ?? null,
            }),
            { headers },
          );
        });
        const wait: Interface["wait"] = Effect.fn("Client.wait")(
          function* (request) {
            return yield* rpc["Resource.Wait"](request, { headers });
          },
        );
        const shellList: Interface["shellList"] = Effect.fn("Client.shellList")(
          function* (request) {
            return yield* rpc["Shell.List"](request, { headers });
          },
        );
        const shellInspect: Interface["shellInspect"] = Effect.fn(
          "Client.shellInspect",
        )(function* (request) {
          return yield* rpc["Shell.Inspect"](request, { headers });
        });
        const shellWrite: Interface["shellWrite"] = Effect.fn(
          "Client.shellWrite",
        )(function* (request) {
          return yield* rpc["Shell.Write"](request, { headers });
        });
        const shellCloseStdin: Interface["shellCloseStdin"] = Effect.fn(
          "Client.shellCloseStdin",
        )(function* (request) {
          return yield* rpc["Shell.CloseStdin"](request, { headers });
        });
        const shellSignal: Interface["shellSignal"] = Effect.fn(
          "Client.shellSignal",
        )(function* (request) {
          return yield* rpc["Shell.Signal"](request, { headers });
        });
        return Service.of({
          heartbeatStart,
          heartbeatGet,
          heartbeatStop,
          watch,
          shellOpen,
          shellSnapshot,
          wait,
          shellList,
          shellInspect,
          shellWrite,
          shellCloseStdin,
          shellSignal,
        });
      }),
    ),
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(NodeSocket.layerNet({ path: options.socketPath })),
    Layer.provide(RpcSerialization.layerNdjson),
  );

export * as Client from "./index.ts";
