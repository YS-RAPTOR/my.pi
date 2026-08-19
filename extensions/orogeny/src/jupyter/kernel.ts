import {
  Cause,
  Chunk,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  pipe,
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
import { messageFrom } from "#o/error";
import { Connection } from "#o/jupyter/connection";
import {
  ClearOutputContent,
  DisplayContent,
  ErrorContent,
  ExecuteReplyContent,
  ExecuteRequestContent,
  InterruptReplyContent,
  InterruptRequestContent,
  JupyterHeader,
  JupyterMessage,
  type JupyterRequestContent,
  KernelInfoReplyContent,
  KernelInfoRequestContent,
  MimeBundle,
  ShutdownReplyContent,
  ShutdownRequestContent,
  StatusContent,
  StreamContent,
} from "#o/jupyter/schema";
import { Codec } from "#o/jupyter/codec";
import { Transport } from "#o/jupyter/transport";

const DEFAULT_DENO_EXECUTABLE = "deno";
const DIAGNOSTIC_BYTES = 64 * 1024;
const IOPUB_PROBE_ATTEMPTS = 40;

export class OpenInput extends Data.Class<{
  readonly denoExecutable: string;
}> {}

export type Output = Data.TaggedEnum<{
  stream: {
    readonly name: "stdout" | "stderr";
    readonly text: string;
  };
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
  clear: {
    readonly wait: boolean;
  };
}>;

export const Output = Data.taggedEnum<Output>();

export class ExecutionResult extends Data.Class<{
  readonly status: "succeeded" | "failed";
  readonly reply: ExecuteReplyContent;
}> {}

export class OperationFailed extends Data.TaggedError(
  "JupyterKernelOperationFailed",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export class Execution extends Data.Class<{
  readonly requestId: string;
  readonly outputs: Stream.Stream<Output, OperationFailed>;
  readonly completion: Effect.Effect<ExecutionResult, OperationFailed>;
}> {}

export class Handle extends Data.Class<{
  readonly start: (code: string) => Effect.Effect<Execution, OperationFailed>;
  readonly interrupt: Effect.Effect<void, OperationFailed>;
  readonly shutdown: Effect.Effect<void, OperationFailed>;
}> {}

export type Interface = Readonly<{
  open: (
    input?: OpenInput,
  ) => Effect.Effect<Handle, OperationFailed, Scope.Scope>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "orogeny/Jupyter.Kernel",
) {}

const mapOperation = (operation: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new OperationFailed({ operation, message: messageFrom(cause) }),
  );

const operationFailureFromCause = (
  cause: Cause.Cause<OperationFailed>,
): OperationFailed =>
  pipe(
    Cause.findError(cause),
    Result.match({
      onFailure: (failure) =>
        new OperationFailed({
          operation: "run Jupyter execution",
          message: Cause.pretty(failure),
        }),
      onSuccess: (failure) => failure,
    }),
  );

const parentMessageId = (message: JupyterMessage): Option.Option<string> =>
  Schema.decodeUnknownOption(JupyterHeader)(message.parentHeader).pipe(
    Option.map((header) => header.msg_id),
  );

const hasParentMessageId = (
  message: JupyterMessage,
  requestId: string,
): boolean => Option.contains(parentMessageId(message), requestId);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const connections = yield* Connection.Service;
    const transport = yield* Transport.Service;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const open: Interface["open"] = Effect.fn("Jupyter.Kernel.open")(
      function* (input) {
        const scope = yield* Effect.scope;
        const artifact = yield* connections.open.pipe(
          mapOperation("create Jupyter connection information"),
        );
        const processHandle = yield* spawner
          .spawn(
            ChildProcess.make(
              input?.denoExecutable ?? DEFAULT_DENO_EXECUTABLE,
              ["jupyter", "--kernel", "--conn", artifact.path],
              {
                cwd: artifact.directory,
                detached: true,
                extendEnv: true,
                forceKillAfter: "1 second",
                stdin: "ignore",
                stdout: "ignore",
                stderr: "pipe",
              },
            ),
          )
          .pipe(mapOperation("start Deno Jupyter kernel"));

        const diagnostics = yield* Ref.make("");
        const closed = yield* Ref.make(false);

        yield* pipe(
          processHandle.stderr,
          Stream.decodeText,
          Stream.runForEach((text) =>
            Ref.update(diagnostics, (current) =>
              `${current}${text}`.slice(-DIAGNOSTIC_BYTES),
            ),
          ),
          Effect.ignoreCause,
          Effect.forkScoped,
        );

        yield* pipe(
          processHandle.exitCode,
          Effect.andThen(Ref.set(closed, true)),
          Effect.ignoreCause,
          Effect.forkScoped,
        );

        const withDiagnostics = <A, R>(
          self: Effect.Effect<A, OperationFailed, R>,
        ): Effect.Effect<A, OperationFailed, R> =>
          self.pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                const detail = (yield* Ref.get(diagnostics)).trim();
                if (detail.length === 0) return yield* cause;
                return yield* new OperationFailed({
                  operation: cause.operation,
                  message: `${cause.message}\n${detail}`,
                });
              }),
            ),
          );

        const endpoint = (port: number) =>
          new Transport.Endpoint({ host: artifact.info.ip, port });

        const { shell, control, iopub } = yield* pipe(
          Effect.all(
            {
              shell: transport.dealer(endpoint(artifact.info.shell_port)),
              control: transport.dealer(endpoint(artifact.info.control_port)),
              iopub: transport.subscriber(endpoint(artifact.info.iopub_port)),
            },
            { concurrency: "unbounded" },
          ),
          mapOperation("open Jupyter ZeroMQ channels"),
          withDiagnostics,
        );

        const key = artifact.info.key;
        const session = globalThis.crypto.randomUUID();
        const shellRequests = yield* Semaphore.make(1);
        const controlRequests = yield* Semaphore.make(1);

        const receiveMessage = Effect.fn("Jupyter.Kernel.__receiveMessage")(
          function* (channel: Transport.Receiver | Transport.DealerChannel) {
            const frames = yield* channel.receive.pipe(
              mapOperation("receive Jupyter message"),
            );
            return yield* Codec.decode(frames, key).pipe(
              mapOperation("decode Jupyter message"),
            );
          },
        );

        const sendRequest = Effect.fn("Jupyter.Kernel.__sendRequest")(
          function* (
            channel: Transport.DealerChannel,
            type: string,
            content: JupyterRequestContent,
          ) {
            const request = yield* Codec.createRequest(
              new Codec.RequestInput({ type, content, session }),
            ).pipe(mapOperation(`create Jupyter ${type}`));
            const frames = yield* Codec.encode(request, key).pipe(
              mapOperation(`encode Jupyter ${type}`),
            );
            yield* channel
              .send(frames)
              .pipe(mapOperation(`send Jupyter ${type}`));
            return request;
          },
        );

        const messageStream = (
          channel: Transport.Receiver | Transport.DealerChannel,
        ) => Stream.fromEffectRepeat(receiveMessage(channel));

        const receiveReply = Effect.fn("Jupyter.Kernel.__receiveReply")(
          function* (
            channel: Transport.DealerChannel,
            requestId: string,
            replyType: string,
          ) {
            return yield* pipe(
              messageStream(channel),
              Stream.filter(
                (message) =>
                  hasParentMessageId(message, requestId) &&
                  message.header.msg_type === replyType,
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new OperationFailed({
                        operation: `receive Jupyter ${replyType}`,
                        message: "The Jupyter reply stream ended",
                      }),
                    ),
                  onSome: (message) => Effect.succeed(message),
                }),
              ),
            );
          },
        );

        const requestReply = Effect.fn("Jupyter.Kernel.__requestReply")(
          function* (
            channel: Transport.DealerChannel,
            requestType: string,
            replyType: string,
            content: JupyterRequestContent,
          ) {
            const request = yield* sendRequest(channel, requestType, content);
            return yield* receiveReply(
              channel,
              request.header.msg_id,
              replyType,
            );
          },
        );

        const isIdleMessage = Effect.fn("Jupyter.Kernel.__isIdleMessage")(
          function* (message: JupyterMessage) {
            return yield* pipe(
              Match.value(message.header.msg_type),
              Match.when("status", () =>
                pipe(
                  Schema.decodeUnknownEffect(StatusContent)(message.content),
                  mapOperation("validate Jupyter kernel status"),
                  Effect.map((content) => content.execution_state === "idle"),
                ),
              ),
              Match.orElse(() => Effect.succeed(false)),
            );
          },
        );

        const decodeIopubOutput = Effect.fn(
          "Jupyter.Kernel.__decodeIopubOutput",
        )(function* (message: JupyterMessage) {
          return yield* pipe(
            Match.value(message.header.msg_type),
            Match.when("stream", () =>
              pipe(
                Schema.decodeUnknownEffect(StreamContent)(message.content),
                mapOperation("validate Jupyter stream output"),
                Effect.map((content) =>
                  Option.some(
                    Output.stream({
                      name: content.name,
                      text: content.text,
                    }),
                  ),
                ),
              ),
            ),
            Match.whenOr(
              "execute_result",
              "display_data",
              "update_display_data",
              (kind) =>
                pipe(
                  Schema.decodeUnknownEffect(DisplayContent)(message.content),
                  mapOperation("validate Jupyter display output"),
                  Effect.map((content) =>
                    Option.some(
                      Output.display({
                        kind,
                        data: content.data,
                        metadata: content.metadata,
                        transient: Option.fromUndefinedOr(content.transient),
                      }),
                    ),
                  ),
                ),
            ),
            Match.when("error", () =>
              pipe(
                Schema.decodeUnknownEffect(ErrorContent)(message.content),
                mapOperation("validate Jupyter error output"),
                Effect.map((content) =>
                  Option.some(
                    Output.error({
                      name: content.ename,
                      value: content.evalue,
                      traceback: Chunk.fromIterable(content.traceback),
                    }),
                  ),
                ),
              ),
            ),
            Match.when("clear_output", () =>
              pipe(
                Schema.decodeUnknownEffect(ClearOutputContent)(message.content),
                mapOperation("validate Jupyter clear output"),
                Effect.map((content) =>
                  Option.some(Output.clear({ wait: content.wait })),
                ),
              ),
            ),
            Match.orElse(() => Effect.succeed(Option.none<Output>())),
          );
        });

        const receiveIopubIdle = Effect.fn("Jupyter.Kernel.__receiveIopubIdle")(
          function* (requestId: string) {
            return yield* pipe(
              messageStream(iopub),
              Stream.filter((message) =>
                hasParentMessageId(message, requestId),
              ),
              Stream.filterEffect(isIdleMessage),
              Stream.take(1),
              Stream.runDrain,
            );
          },
        );

        const kernelInfoRequest = yield* Schema.decodeUnknownEffect(
          KernelInfoRequestContent,
        )({}).pipe(mapOperation("validate Jupyter kernel_info_request"));
        const probeIopub = Effect.gen(function* () {
          const request = yield* sendRequest(
            shell,
            "kernel_info_request",
            kernelInfoRequest,
          );
          const reply = yield* receiveReply(
            shell,
            request.header.msg_id,
            "kernel_info_reply",
          ).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                Effect.fail(
                  new OperationFailed({
                    operation: "health-check Deno Jupyter kernel",
                    message:
                      "The kernel did not answer kernel_info_request within 5 seconds",
                  }),
                ),
            }),
          );
          yield* Schema.decodeUnknownEffect(KernelInfoReplyContent)(
            reply.content,
          ).pipe(mapOperation("validate Jupyter kernel_info_reply"));
          return Option.isSome(
            yield* receiveIopubIdle(request.header.msg_id).pipe(
              Effect.timeoutOption(250),
            ),
          );
        });

        const healthCheck = pipe(
          probeIopub,
          Effect.repeat({
            until: (ready) => ready,
            times: IOPUB_PROBE_ATTEMPTS - 1,
            schedule: Schedule.spaced(50),
          }),
          Effect.filterOrFail(
            (ready) => ready,
            () =>
              new OperationFailed({
                operation: "health-check Deno Jupyter kernel",
                message: "The Jupyter IOPub channel did not become ready",
              }),
          ),
          Effect.asVoid,
        );
        yield* shellRequests.withPermit(healthCheck).pipe(withDiagnostics);

        const ensureOpen = Effect.fn("Jupyter.Kernel.__ensureOpen")(
          function* () {
            if (!(yield* Ref.get(closed))) return;
            return yield* new OperationFailed({
              operation: "use Deno Jupyter kernel",
              message: "The kernel process is closed",
            });
          },
        );

        const publishIopub = Effect.fn("Jupyter.Kernel.__publishIopub")(
          function* (
            requestId: string,
            outputQueue: Queue.Enqueue<Output, OperationFailed | Cause.Done>,
          ) {
            return yield* pipe(
              messageStream(iopub),
              Stream.filter((message) =>
                hasParentMessageId(message, requestId),
              ),
              Stream.takeUntilEffect(isIdleMessage),
              Stream.mapEffect(decodeIopubOutput),
              Stream.filter(Option.isSome),
              Stream.map((output) => output.value),
              Stream.runForEach((output) => Queue.offer(outputQueue, output)),
            );
          },
        );

        const start: Handle["start"] = Effect.fn("Jupyter.Kernel.start")(
          function* (code) {
            const outputQueue = yield* Queue.unbounded<
              Output,
              OperationFailed | Cause.Done
            >();
            const started = yield* Deferred.make<string, OperationFailed>();
            const completion = yield* Deferred.make<
              ExecutionResult,
              OperationFailed
            >();

            const coordinator = shellRequests.withPermit(
              Effect.gen(function* () {
                yield* ensureOpen();
                const content = yield* Schema.decodeUnknownEffect(
                  ExecuteRequestContent,
                )({
                  code,
                  silent: false,
                  store_history: true,
                  user_expressions: {},
                  allow_stdin: false,
                  stop_on_error: false,
                }).pipe(mapOperation("validate Jupyter execute_request"));
                const request = yield* sendRequest(
                  shell,
                  "execute_request",
                  content,
                );
                yield* Deferred.succeed(started, request.header.msg_id);

                const { replyMessage } = yield* Effect.all(
                  {
                    replyMessage: receiveReply(
                      shell,
                      request.header.msg_id,
                      "execute_reply",
                    ),
                    outputs: publishIopub(request.header.msg_id, outputQueue),
                  },
                  { concurrency: "unbounded" },
                );
                const reply = yield* Schema.decodeUnknownEffect(
                  ExecuteReplyContent,
                )(replyMessage.content).pipe(
                  mapOperation("validate Jupyter execute_reply"),
                );
                return new ExecutionResult({
                  status: reply.status === "ok" ? "succeeded" : "failed",
                  reply,
                });
              }),
            );

            const finalized = pipe(
              coordinator,
              Effect.onExit((exit) =>
                Exit.match(exit, {
                  onFailure: (cause) => {
                    const failure = operationFailureFromCause(cause);
                    return pipe(
                      Effect.all(
                        {
                          outputs: Queue.fail(outputQueue, failure),
                          started: Deferred.fail(started, failure),
                        },
                        { discard: true },
                      ),
                      Effect.asVoid,
                    );
                  },
                  onSuccess: () => Queue.end(outputQueue).pipe(Effect.asVoid),
                }),
              ),
            );
            yield* pipe(
              finalized,
              Deferred.into(completion),
              Effect.forkIn(scope),
            );

            const requestId = yield* Deferred.await(started);
            return new Execution({
              requestId,
              outputs: Stream.fromQueue(outputQueue),
              completion: Deferred.await(completion),
            });
          },
        );

        const interrupt: Handle["interrupt"] = controlRequests.withPermit(
          Effect.gen(function* () {
            if (yield* Ref.get(closed)) return;
            const content = yield* Schema.decodeUnknownEffect(
              InterruptRequestContent,
            )({}).pipe(mapOperation("validate Jupyter interrupt_request"));
            const reply = yield* requestReply(
              control,
              "interrupt_request",
              "interrupt_reply",
              content,
            ).pipe(
              Effect.timeoutOrElse({
                duration: "5 seconds",
                orElse: () =>
                  Effect.fail(
                    new OperationFailed({
                      operation: "interrupt Deno Jupyter kernel",
                      message: "The kernel did not answer within 5 seconds",
                    }),
                  ),
              }),
            );
            yield* Schema.decodeUnknownEffect(InterruptReplyContent)(
              reply.content,
            ).pipe(mapOperation("validate Jupyter interrupt_reply"));
          }),
        );

        const shutdown: Handle["shutdown"] = controlRequests.withPermit(
          Effect.gen(function* () {
            const wasClosed = yield* Ref.getAndSet(closed, true);
            if (wasClosed) return;

            const graceful = pipe(
              Effect.gen(function* () {
                const content = yield* Schema.decodeUnknownEffect(
                  ShutdownRequestContent,
                )({ restart: false }).pipe(
                  mapOperation("validate Jupyter shutdown_request"),
                );
                const reply = yield* requestReply(
                  control,
                  "shutdown_request",
                  "shutdown_reply",
                  content,
                );
                yield* Schema.decodeUnknownEffect(ShutdownReplyContent)(
                  reply.content,
                ).pipe(mapOperation("validate Jupyter shutdown_reply"));
              }),
              Effect.timeoutOption("2 seconds"),
              Effect.ignore,
            );
            yield* graceful;

            const exited = yield* pipe(
              processHandle.exitCode,
              Effect.as(true),
              Effect.orElseSucceed(() => false),
              Effect.timeoutOrElse({
                duration: "2 seconds",
                orElse: () => Effect.succeed(false),
              }),
            );
            if (exited) return;
            yield* processHandle
              .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
              .pipe(mapOperation("stop Deno Jupyter kernel"));
          }),
        );

        return new Handle({ start, interrupt, shutdown });
      },
    );

    return Service.of({ open });
  }),
);

export * as Kernel from "./kernel.ts";
