import { NodeSocketServer } from "@effect/platform-node";
import {
  Array as Arr,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Result,
  Schema,
  Scope,
} from "effect";
import { messageFrom } from "#o/error";
import { ConnectionInfo } from "#o/jupyter/schema";

const LOOPBACK_HOST = "127.0.0.1";
const PORT_COUNT = 5;

export class Artifact extends Data.Class<{
  readonly info: ConnectionInfo;
  readonly directory: string;
  readonly path: string;
}> {}

export class OpenFailed extends Data.TaggedError("ConnectionOpenFailed")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type Interface = Readonly<{
  open: Effect.Effect<Artifact, OpenFailed, Scope.Scope>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "orogeny/Jupyter.Connection",
) {}

const randomHex = (bytes: number): string => {
  const value = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const reserveLoopbackPorts = Effect.fn(
      "Jupyter.Connection.__reserveLoopbackPorts",
    )(function* () {
      const servers = yield* Effect.forEach(
        Array.from({ length: PORT_COUNT }),
        () => NodeSocketServer.make({ host: LOOPBACK_HOST, port: 0 }),
        { concurrency: "unbounded" },
      );
      const ports = Arr.filterMap(servers, (server) =>
        Predicate.isTagged(server.address, "TcpAddress")
          ? Result.succeed(server.address.port)
          : Result.failVoid,
      );
      if (Predicate.isTupleOf(ports, PORT_COUNT)) return ports;
      return yield* new OpenFailed({
        operation: "reserve Jupyter ports",
        message: `Expected ${PORT_COUNT} TCP ports, received ${ports.length}`,
      });
    });

    const open: Interface["open"] = Effect.gen(function* () {
      const ports = yield* Effect.scoped(reserveLoopbackPorts()).pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, "ConnectionOpenFailed")
            ? cause
            : new OpenFailed({
                operation: "reserve Jupyter ports",
                message: messageFrom(cause),
              }),
        ),
      );
      const [shell, iopub, stdin, control, heartbeat] = ports;

      const info = yield* Schema.decodeUnknownEffect(ConnectionInfo)({
        ip: LOOPBACK_HOST,
        transport: "tcp",
        shell_port: shell,
        iopub_port: iopub,
        stdin_port: stdin,
        control_port: control,
        hb_port: heartbeat,
        signature_scheme: "hmac-sha256",
        key: randomHex(32),
        kernel_name: "deno",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OpenFailed({
              operation: "validate Jupyter connection information",
              message: messageFrom(cause),
            }),
        ),
      );
      const directory = yield* files
        .makeTempDirectoryScoped({ prefix: "orogeny-deno-kernel-" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OpenFailed({
                operation: "create Jupyter connection directory",
                message: messageFrom(cause),
              }),
          ),
        );
      const path = paths.join(directory, "connection.json");
      yield* files
        .writeFileString(path, `${JSON.stringify(info, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OpenFailed({
                operation: "write Jupyter connection file",
                message: messageFrom(cause),
              }),
          ),
        );
      return new Artifact({ info, directory, path });
    }).pipe(Effect.withSpan("Jupyter.Connection.open"));

    return Service.of({ open });
  }),
);

export * as Connection from "./connection.ts";
