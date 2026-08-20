import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NodeSocketServer } from "@effect/platform-node";
import {
  Array as Arr,
  Cause,
  Chunk,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Filter,
  Layer,
  Match,
  Option,
  Path,
  pipe,
  Predicate,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { context, Dealer, Subscriber } from "zeromq";

const HOST = "127.0.0.1";
const DELIMITER = new TextEncoder().encode("<IDS|MSG>");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
);
class ConnectionInfo extends Schema.Class<ConnectionInfo>("ConnectionInfo")({
  ip: Schema.Literal(HOST),
  transport: Schema.Literal("tcp"),
  shell_port: Port,
  iopub_port: Port,
  stdin_port: Port,
  control_port: Port,
  hb_port: Port,
  signature_scheme: Schema.Literal("hmac-sha256"),
  key: Schema.String,
  kernel_name: Schema.Literal("deno"),
}) {}
class Header extends Schema.Class<Header>("Header")({
  msg_id: Schema.String,
  session: Schema.String,
  username: Schema.String,
  date: Schema.String,
  msg_type: Schema.String,
  version: Schema.String,
}) {}
class Message extends Schema.Class<Message>("Message")({
  identities: Schema.Array(Schema.Uint8Array),
  header: Header,
  parentHeader: Schema.Json,
  metadata: Schema.Json,
  content: Schema.Json,
  buffers: Schema.Array(Schema.Uint8Array),
}) {}
const Envelope = Schema.TupleWithRest(
  Schema.Tuple([
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
    Schema.Uint8Array,
  ]),
  [Schema.Uint8Array],
);
export class MimeBundle extends Schema.Opaque<MimeBundle>()(
  Schema.Record(Schema.String, Schema.Json),
) {}
class Ok extends Schema.Class<Ok>("Ok")({ status: Schema.Literal("ok") }) {}
class StreamOutput extends Schema.Class<StreamOutput>("StreamOutput")({
  name: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
}) {}
class DisplayOutput extends Schema.Class<DisplayOutput>("DisplayOutput")({
  data: MimeBundle,
  metadata: Schema.Json,
  transient: Schema.optionalKey(Schema.Json),
}) {}
class ErrorOutput extends Schema.Class<ErrorOutput>("ErrorOutput")({
  ename: Schema.String,
  evalue: Schema.String,
  traceback: Schema.Array(Schema.String),
}) {}
class Clear extends Schema.Class<Clear>("Clear")({ wait: Schema.Boolean }) {}
class Status extends Schema.Class<Status>("Status")({
  execution_state: Schema.Literals(["busy", "idle", "starting"]),
}) {}
class Reply extends Schema.Class<Reply>("Reply")({
  status: Schema.Literals(["ok", "error"]),
  evalue: Schema.optionalKey(Schema.String),
}) {}
const HeaderJson = Schema.fromJsonString(Header);
const JsonFrame = Schema.fromJsonString(Schema.Json);

type FailureData = { readonly operation: string; readonly message: string };
export class OperationFailed extends Data.TaggedError("Jupyter")<FailureData> {}
const failed = (operation: string, cause: unknown) =>
  new OperationFailed({ operation, message: String(cause) });
const mapFailed = (operation: string) =>
  Effect.mapError((cause: unknown) => failed(operation, cause));

class Signed extends Data.Class<{
  readonly header: Uint8Array;
  readonly parent: Uint8Array;
  readonly metadata: Uint8Array;
  readonly content: Uint8Array;
}> {}
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && timingSafeEqual(a, b);
const signedFrames = (value: Signed) =>
  Chunk.make(value.header, value.parent, value.metadata, value.content);
const signature = (value: Signed, key: string) =>
  encoder.encode(
    createHmac("sha256", key)
      .update(value.header)
      .update(value.parent)
      .update(value.metadata)
      .update(value.content)
      .digest("hex"),
  );
const createMessage = (type: string, content: Schema.Json, session: string) =>
  Schema.decodeUnknownEffect(Message)({
    identities: [],
    header: {
      msg_id: randomUUID(),
      session,
      username: "orogeny",
      date: new Date().toISOString(),
      msg_type: type,
      version: "5.3",
    },
    parentHeader: {},
    metadata: {},
    content,
    buffers: [],
  }).pipe(mapFailed(`create Jupyter ${type}`));
const encodeMessage = Effect.fn("Jupyter.encode")(function* (
  message: Message,
  key: string,
) {
  const json = yield* Effect.all({
    header: Schema.encodeEffect(HeaderJson)(message.header),
    parent: Schema.encodeEffect(JsonFrame)(message.parentHeader),
    metadata: Schema.encodeEffect(JsonFrame)(message.metadata),
    content: Schema.encodeEffect(JsonFrame)(message.content),
  }).pipe(mapFailed("encode Jupyter message"));
  const signed = new Signed({
    header: encoder.encode(json.header),
    parent: encoder.encode(json.parent),
    metadata: encoder.encode(json.metadata),
    content: encoder.encode(json.content),
  });
  return pipe(
    Chunk.fromIterable<Uint8Array>(message.identities),
    Chunk.append(DELIMITER),
    Chunk.append(signature(signed, key)),
    Chunk.appendAll(signedFrames(signed)),
    Chunk.appendAll(Chunk.fromIterable(message.buffers)),
  );
});
const decodeMessage = Effect.fn("Jupyter.decode")(function* (
  frames: Chunk.Chunk<Uint8Array>,
  key: string,
) {
  const [identities, rest] = Chunk.splitWhere(frames, (frame) =>
    equal(frame, DELIMITER),
  );
  if (Chunk.isEmpty(rest))
    return yield* failed("decode Jupyter envelope", "Missing delimiter");
  const [supplied, header, parent, metadata, content, ...buffers] =
    yield* Schema.decodeUnknownEffect(Envelope)(
      Chunk.toReadonlyArray(Chunk.drop(rest, 1)),
    ).pipe(mapFailed("decode Jupyter envelope"));
  const signed = new Signed({ header, parent, metadata, content });
  if (!equal(supplied, signature(signed, key)))
    return yield* failed("verify Jupyter message", "Invalid signature");
  const json = yield* Effect.all({
    header: Schema.decodeUnknownEffect(HeaderJson)(decoder.decode(header)),
    parentHeader: Schema.decodeUnknownEffect(JsonFrame)(decoder.decode(parent)),
    metadata: Schema.decodeUnknownEffect(JsonFrame)(decoder.decode(metadata)),
    content: Schema.decodeUnknownEffect(JsonFrame)(decoder.decode(content)),
  }).pipe(mapFailed("decode Jupyter message"));
  return yield* Schema.decodeUnknownEffect(Message)({
    identities: Chunk.toReadonlyArray(identities),
    ...json,
    buffers,
  }).pipe(mapFailed("validate Jupyter message"));
});

class Channel extends Data.Class<{
  readonly receive: () => Effect.Effect<
    Chunk.Chunk<Uint8Array>,
    OperationFailed
  >;
  readonly send: (
    frames: Chunk.Chunk<Uint8Array>,
  ) => Effect.Effect<void, OperationFailed>;
}> {}
const configure = <Socket extends Dealer | Subscriber>(socket: Socket) => {
  socket.handshakeInterval = 5_000;
  socket.linger = 0;
  socket.maxMessageSize = 2 * 1024 * 1024 * 1024 - 1;
  return socket;
};
const acquireSocket = <Socket extends Dealer | Subscriber>(
  address: string,
  make: () => Socket,
) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const socket = configure(make());
        socket.connect(address);
        return socket;
      },
      catch: (cause) => failed(`connect ZeroMQ ${address}`, cause),
    }),
    (socket) => Effect.sync(() => socket.close()),
  );
const makeReceiver = Effect.fn("Jupyter.receiver")(function* (
  socket: Dealer | Subscriber,
  operation: string,
) {
  const queue = yield* pipe(
    Stream.fromAsyncIterable(socket, (cause) => failed(operation, cause)),
    Stream.map((frames) => Chunk.fromIterable<Uint8Array>(frames)),
    Stream.toQueue({ capacity: 64 }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
  return () => Queue.take(queue).pipe(mapFailed(operation));
});
const dealer = Effect.fn("Jupyter.dealer")(function* (address: string) {
  const socket = yield* acquireSocket(address, () => {
    const socket = new Dealer();
    socket.sendTimeout = 5_000;
    return socket;
  });
  const receive = yield* makeReceiver(socket, `receive ZeroMQ ${address}`);
  const lock = yield* Semaphore.make(1);
  return new Channel({
    receive,
    send: (frames) =>
      lock.withPermit(
        Effect.tryPromise({
          try: () => socket.send(Array.from(frames)),
          catch: (cause) => failed(`send ZeroMQ ${address}`, cause),
        }),
      ),
  });
});
const subscriber = Effect.fn("Jupyter.subscriber")(function* (address: string) {
  const socket = yield* acquireSocket(address, () => {
    const socket = new Subscriber();
    socket.subscribe();
    return socket;
  });
  return yield* makeReceiver(socket, `receive ZeroMQ ${address}`);
});

export type Output = Data.TaggedEnum<{
  stream: { readonly name: "stdout" | "stderr"; readonly text: string };
  display: {
    readonly kind: "execute_result" | "display_data" | "update_display_data";
    readonly data: MimeBundle;
    readonly metadata: Schema.Json;
    readonly transient: Option.Option<Schema.Json>;
  };
  error: {
    readonly name: string;
    readonly value: string;
    readonly traceback: Chunk.Chunk<string>;
  };
  clear: { readonly wait: boolean };
}>;
export const Output = Data.taggedEnum<Output>();
export class ExecutionResult extends Data.Class<{
  readonly status: "succeeded" | "failed";
  readonly reply: Reply;
}> {}
export class Execution extends Data.Class<{
  readonly outputs: Stream.Stream<Output, OperationFailed>;
  readonly completion: Effect.Effect<ExecutionResult, OperationFailed>;
}> {}
export class Handle extends Data.Class<{
  readonly start: (code: string) => Effect.Effect<Execution, OperationFailed>;
  readonly interrupt: Effect.Effect<void, OperationFailed>;
  readonly shutdown: Effect.Effect<void, OperationFailed>;
}> {}
export type Interface = Readonly<{
  open: Effect.Effect<Handle, OperationFailed, Scope.Scope>;
}>;
export class Service extends Context.Service<Service, Interface>()(
  "orogeny/Jupyter.Kernel",
) {}

const connection = Effect.fn("Jupyter.connection")(function* () {
  const files = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const servers = yield* Effect.scoped(
    NodeSocketServer.make({ host: HOST, port: 0 }).pipe(
      Effect.replicateEffect(5, { concurrency: "unbounded" }),
    ),
  );
  const ports = Arr.filterMap(servers, (server) =>
    Predicate.isTagged(server.address, "TcpAddress")
      ? Result.succeed(server.address.port)
      : Result.failVoid,
  );
  if (!Predicate.isTupleOf(ports, 5))
    return yield* failed("reserve Jupyter ports", "Missing TCP port");
  const [shell, iopub, stdin, control, heartbeat] = ports;
  const info = yield* Schema.decodeUnknownEffect(ConnectionInfo)({
    ip: HOST,
    transport: "tcp",
    shell_port: shell,
    iopub_port: iopub,
    stdin_port: stdin,
    control_port: control,
    hb_port: heartbeat,
    signature_scheme: "hmac-sha256",
    key: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    kernel_name: "deno",
  }).pipe(mapFailed("validate Jupyter connection"));
  const directory = yield* files
    .makeTempDirectoryScoped({ prefix: "orogeny-deno-kernel-" })
    .pipe(mapFailed("create Jupyter connection directory"));
  const path = paths.join(directory, "connection.json");
  yield* files
    .writeFileString(path, `${JSON.stringify(info, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    .pipe(mapFailed("write Jupyter connection"));
  return { info, directory, path } as const;
});
const parentId = (message: Message) =>
  Schema.decodeUnknownOption(Header)(message.parentHeader).pipe(
    Option.map((header) => header.msg_id),
  );

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* Effect.sync(() => {
      context.blocky = false;
    });
    const open: Interface["open"] = Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const artifact = yield* pipe(
        connection(),
        Effect.provideService(FileSystem.FileSystem, files),
        Effect.provideService(Path.Path, paths),
        mapFailed("open Jupyter connection"),
      );
      const process = yield* spawner
        .spawn(
          ChildProcess.make(
            "deno",
            ["jupyter", "--kernel", "--conn", artifact.path],
            {
              cwd: artifact.directory,
              detached: true,
              extendEnv: true,
              forceKillAfter: "1 second",
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            },
          ),
        )
        .pipe(mapFailed("start Deno Jupyter kernel"));
      const closed = yield* Ref.make(false);
      const address = (port: number) => `tcp://${artifact.info.ip}:${port}`;
      const channels = yield* Effect.all(
        {
          shell: dealer(address(artifact.info.shell_port)),
          control: dealer(address(artifact.info.control_port)),
          iopub: subscriber(address(artifact.info.iopub_port)),
        },
        { concurrency: "unbounded" },
      );
      const { shell, control, iopub } = channels;
      const key = artifact.info.key;
      const session = crypto.randomUUID();
      const shellLock = yield* Semaphore.make(1);
      const controlLock = yield* Semaphore.make(1);
      const messages = (
        receive: () => Effect.Effect<Chunk.Chunk<Uint8Array>, OperationFailed>,
      ) =>
        Stream.fromEffectRepeat(
          receive().pipe(
            Effect.flatMap((frames) => decodeMessage(frames, key)),
          ),
        );
      const send = Effect.fn("Jupyter.send")(function* (
        channel: Channel,
        type: string,
        content: Schema.Json,
      ) {
        const request = yield* createMessage(type, content, session);
        yield* channel.send(yield* encodeMessage(request, key));
        return request;
      });
      const reply = Effect.fn("Jupyter.reply")(function* (
        channel: Channel,
        requestId: string,
        type: string,
      ) {
        return yield* pipe(
          messages(channel.receive),
          Stream.filter(
            (message) =>
              Option.contains(parentId(message), requestId) &&
              message.header.msg_type === type,
          ),
          Stream.runHead,
          Effect.flatMap(
            Effect.fromOption(() =>
              failed(`receive Jupyter ${type}`, "Reply stream ended"),
            ),
          ),
        );
      });
      const requestReply = Effect.fn("Jupyter.requestReply")(function* (
        channel: Channel,
        requestType: string,
        replyType: string,
        content: Schema.Json,
      ) {
        const request = yield* send(channel, requestType, content);
        return yield* reply(channel, request.header.msg_id, replyType);
      });
      const related = (requestId: string) =>
        messages(iopub).pipe(
          Stream.filter((message) =>
            Option.contains(parentId(message), requestId),
          ),
        );
      const idle = (message: Message) =>
        message.header.msg_type !== "status"
          ? Effect.succeed(false)
          : pipe(
              Schema.decodeUnknownEffect(Status)(message.content),
              mapFailed("validate Jupyter status"),
              Effect.map((value) => value.execution_state === "idle"),
            );
      const decodeOutput = (message: Message) =>
        pipe(
          Match.value(message.header.msg_type),
          Match.when("stream", () =>
            Schema.decodeUnknownEffect(StreamOutput)(message.content).pipe(
              Effect.map((value) => Option.some(Output.stream(value))),
            ),
          ),
          Match.whenOr(
            "execute_result",
            "display_data",
            "update_display_data",
            (kind) =>
              Schema.decodeUnknownEffect(DisplayOutput)(message.content).pipe(
                Effect.map((value) =>
                  Option.some(
                    Output.display({
                      kind,
                      data: value.data,
                      metadata: value.metadata,
                      transient: Option.fromUndefinedOr(value.transient),
                    }),
                  ),
                ),
              ),
          ),
          Match.when("error", () =>
            Schema.decodeUnknownEffect(ErrorOutput)(message.content).pipe(
              Effect.map((value) =>
                Option.some(
                  Output.error({
                    name: value.ename,
                    value: value.evalue,
                    traceback: Chunk.fromIterable(value.traceback),
                  }),
                ),
              ),
            ),
          ),
          Match.when("clear_output", () =>
            Schema.decodeUnknownEffect(Clear)(message.content).pipe(
              Effect.map((value) => Option.some(Output.clear(value))),
            ),
          ),
          Match.orElse(() => Effect.succeed(Option.none<Output>())),
          mapFailed("validate Jupyter output"),
        );
      const publish = (
        requestId: string,
        output: Queue.Enqueue<Output, OperationFailed | Cause.Done>,
      ) =>
        pipe(
          related(requestId),
          Stream.takeUntilEffect(idle),
          Stream.mapEffect(decodeOutput),
          Stream.filterMap(
            Filter.fromPredicateOption((value: Option.Option<Output>) => value),
          ),
          Stream.runForEach((value) => Queue.offer(output, value)),
        );
      const awaitIdle = (requestId: string) =>
        pipe(
          related(requestId),
          Stream.filterEffect(idle),
          Stream.runHead,
          Effect.asVoid,
        );
      const probe = Effect.gen(function* () {
        const request = yield* send(shell, "kernel_info_request", {});
        const response = yield* reply(
          shell,
          request.header.msg_id,
          "kernel_info_reply",
        ).pipe(Effect.timeout("5 seconds"));
        yield* Schema.decodeUnknownEffect(Ok)(response.content).pipe(
          mapFailed("validate kernel_info_reply"),
        );
        return Option.isSome(
          yield* awaitIdle(request.header.msg_id).pipe(
            Effect.timeoutOption(250),
          ),
        );
      });
      yield* shellLock.withPermit(
        pipe(
          probe,
          mapFailed("health-check Deno kernel"),
          Effect.repeat({
            until: (ready) => ready,
            times: 39,
            schedule: Schedule.spaced(50),
          }),
          Effect.filterOrFail(
            (ready) => ready,
            () => failed("health-check Deno kernel", "IOPub not ready"),
          ),
          Effect.asVoid,
        ),
      );

      const start: Handle["start"] = Effect.fn("Jupyter.Kernel.start")(
        function* (code) {
          const output = yield* Queue.unbounded<
            Output,
            OperationFailed | Cause.Done
          >();
          const started = yield* Deferred.make<void, OperationFailed>();
          const coordinator = shellLock.withPermit(
            Effect.gen(function* () {
              if (yield* Ref.get(closed))
                return yield* failed("execute Deno cell", "Kernel is closed");
              const request = yield* send(shell, "execute_request", {
                code,
                silent: false,
                store_history: true,
                user_expressions: {},
                allow_stdin: false,
                stop_on_error: false,
              });
              yield* Deferred.succeed(started, undefined);
              const { response } = yield* Effect.all(
                {
                  response: reply(
                    shell,
                    request.header.msg_id,
                    "execute_reply",
                  ),
                  output: publish(request.header.msg_id, output),
                },
                { concurrency: "unbounded" },
              );
              const value = yield* Schema.decodeUnknownEffect(Reply)(
                response.content,
              ).pipe(mapFailed("validate execute_reply"));
              return new ExecutionResult({
                status: value.status === "ok" ? "succeeded" : "failed",
                reply: value,
              });
            }),
          );
          const finalized = coordinator.pipe(
            Effect.onExit((exit) =>
              Exit.match(exit, {
                onFailure: (cause) => {
                  const error = pipe(
                    Cause.findErrorOption(cause),
                    Option.getOrElse(() =>
                      failed("run Jupyter execution", Cause.pretty(cause)),
                    ),
                  );
                  return Effect.all(
                    [Queue.fail(output, error), Deferred.fail(started, error)],
                    { discard: true },
                  );
                },
                onSuccess: () => Queue.end(output).pipe(Effect.asVoid),
              }),
            ),
          );
          const fiber = yield* finalized.pipe(Effect.forkIn(scope));
          yield* Deferred.await(started);
          return new Execution({
            outputs: Stream.fromQueue(output),
            completion: Fiber.join(fiber),
          });
        },
      );
      const interrupt: Handle["interrupt"] = controlLock.withPermit(
        pipe(
          requestReply(control, "interrupt_request", "interrupt_reply", {}),
          Effect.timeout("5 seconds"),
          Effect.flatMap((response) =>
            Schema.decodeUnknownEffect(Ok)(response.content),
          ),
          mapFailed("interrupt Deno kernel"),
          Effect.asVoid,
        ),
      );
      const shutdown: Handle["shutdown"] = controlLock.withPermit(
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(closed, true)) return;
          yield* pipe(
            requestReply(control, "shutdown_request", "shutdown_reply", {
              restart: false,
            }),
            Effect.flatMap((response) =>
              Schema.decodeUnknownEffect(Ok)(response.content),
            ),
            Effect.timeoutOption("2 seconds"),
            Effect.ignore,
          );
          const exited = yield* pipe(
            process.exitCode,
            Effect.as(true),
            Effect.orElseSucceed(() => false),
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.succeed(false),
            }),
          );
          if (!exited)
            yield* process
              .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
              .pipe(mapFailed("stop Deno Jupyter kernel"));
        }),
      );
      return new Handle({ start, interrupt, shutdown });
    });
    return Service.of({ open });
  }),
);
