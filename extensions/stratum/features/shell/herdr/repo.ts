import { NodeSocket } from "@effect/platform-node";
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Context,
  Layer,
  Option,
  pipe,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { Config } from "#s/config";

const WorkspaceSchema = Schema.Struct({
  workspace_id: Schema.String,
  label: Schema.String,
});

const PaneSchema = Schema.Struct({
  pane_id: Schema.String,
  terminal_id: Schema.String,
  workspace_id: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  foreground_cwd: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  terminal_title_stripped: Schema.optionalKey(Schema.String),
});

const SessionSnapshotSchema = Schema.Struct({
  workspaces: Schema.Array(WorkspaceSchema),
  panes: Schema.Array(PaneSchema),
});

const PaneReadSchema = Schema.Struct({
  text: Schema.String,
  revision: Schema.Int,
  truncated: Schema.Boolean,
});

const ProcessInfoSchema = Schema.Struct({
  shell_pid: Schema.optionalKey(Schema.Int),
  foreground_process_group_id: Schema.optionalKey(Schema.Int),
  foreground_processes: Schema.optionalKey(
    Schema.Array(Schema.Struct({ pid: Schema.Int })),
  ),
});

const ApiResponseSchema = Schema.Struct({
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});

const ApiRequestSchema = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: Schema.Unknown,
});

const SessionResultSchema = Schema.Struct({ snapshot: SessionSnapshotSchema });
const ReadResultSchema = Schema.Struct({ read: PaneReadSchema });
const ProcessInfoResultSchema = Schema.Struct({
  process_info: ProcessInfoSchema,
});
const WorkspaceResultSchema = Schema.Struct({ root_pane: PaneSchema });
const AgentStateSchema = Schema.Literals(["working", "idle"]);
const decodeApiResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ApiResponseSchema),
);
const encodeApiRequest = Schema.encodeEffect(
  Schema.fromJsonString(ApiRequestSchema),
);

export type Pane = typeof PaneSchema.Type;
export type SessionSnapshot = typeof SessionSnapshotSchema.Type;
export type PaneRead = typeof PaneReadSchema.Type;
export type AgentState = typeof AgentStateSchema.Type;

export type ProcessInfo = Readonly<{
  shellPid: number | undefined;
  foregroundProcessGroup: number | undefined;
  foregroundProcesses: ReadonlyArray<Readonly<{ pid: number }>>;
}>;

export class Failure extends Data.TaggedError("HerdrRequestFailed")<{
  readonly message: string;
}> {}

type AttemptFailure = Data.TaggedEnum<{
  transport: { readonly message: string };
  response: { readonly message: string };
}>;

const AttemptFailure = Data.taggedEnum<AttemptFailure>();

export type Interface = Readonly<{
  session: (socketPath: string) => Effect.Effect<SessionSnapshot, Failure>;
  pane: (
    socketPath: string,
    terminalId: string,
  ) => Effect.Effect<Option.Option<Pane>, Failure>;
  read: (
    socketPath: string,
    paneId: string,
    lines: number | null,
  ) => Effect.Effect<PaneRead, Failure>;
  processInfo: (
    socketPath: string,
    paneId: string,
  ) => Effect.Effect<ProcessInfo, Failure>;
  createWorkspace: (
    socketPath: string,
    cwd: string,
    env: Readonly<Record<string, string>>,
  ) => Effect.Effect<Pane, Failure>;
  sendText: (
    socketPath: string,
    paneId: string,
    text: string,
  ) => Effect.Effect<void, Failure>;
  reportAgent: (
    socketPath: string,
    paneId: string,
    source: string,
    agent: string,
    state: AgentState,
  ) => Effect.Effect<void, Failure>;
  releaseAgent: (
    socketPath: string,
    paneId: string,
    source: string,
    agent: string,
  ) => Effect.Effect<void, Failure>;
  ping: (socketPath: string) => Effect.Effect<void, Failure>;
  stop: (socketPath: string) => Effect.Effect<void, Failure>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Shell.Herdr.Repo",
) {}

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const {
      maximumMessageBytes,
      requestRetries,
      requestRetryMillis,
      requestTimeoutMillis,
    } = (yield* Config.Service).shell.herdr;
    const retrySchedule = Schedule.spaced(Duration.millis(requestRetryMillis));

    const call = Effect.fn("Shell.Herdr.Repo.__call")(
      <ResultSchema extends Schema.Top>(
        socketPath: string,
        method: string,
        params: unknown,
        resultSchema: ResultSchema,
      ) =>
        pipe(
          Effect.gen(function* () {
            const socket = yield* NodeSocket.makeNet({
              path: socketPath,
              openTimeout: requestTimeoutMillis,
            });
            const write = yield* socket.writer;
            const result = yield* Deferred.make<
              ResultSchema["Type"],
              AttemptFailure
            >();
            const decoder = new TextDecoder();
            const request = yield* pipe(
              encodeApiRequest({ id: method, method, params }),
              Effect.mapError((cause) =>
                AttemptFailure.response({
                  message: messageFrom(cause, `${method} request was invalid`),
                }),
              ),
            );
            let response = "";

            const exchange = pipe(
              Effect.all(
                [
                  socket.run((chunk) => {
                    response += decoder.decode(chunk, { stream: true });
                    if (Buffer.byteLength(response) > maximumMessageBytes) {
                      return Deferred.fail(
                        result,
                        AttemptFailure.response({
                          message: `${method} response exceeds ${maximumMessageBytes} bytes`,
                        }),
                      );
                    }
                    const newline = response.indexOf("\n");
                    if (newline === -1) return;
                    return pipe(
                      decodeApiResponse(response.slice(0, newline)),
                      Effect.mapError((cause) =>
                        AttemptFailure.response({
                          message: messageFrom(
                            cause,
                            `${method} returned an invalid response`,
                          ),
                        }),
                      ),
                      Effect.flatMap((decoded) => {
                        if (decoded.error !== undefined) {
                          return Deferred.fail(
                            result,
                            AttemptFailure.response({
                              message: decoded.error.message,
                            }),
                          );
                        }
                        return pipe(
                          Schema.decodeUnknownEffect(resultSchema)(
                            decoded.result,
                          ),
                          Effect.mapError((cause) =>
                            AttemptFailure.response({
                              message: messageFrom(
                                cause,
                                `${method} returned an invalid result`,
                              ),
                            }),
                          ),
                          Effect.flatMap((value) =>
                            Deferred.succeed(result, value),
                          ),
                        );
                      }),
                    );
                  }),
                  write(`${request}\n`),
                ],
                { concurrency: "unbounded", discard: true },
              ),
              Effect.mapError((cause) =>
                Predicate.isTagged(cause, "response")
                  ? cause
                  : AttemptFailure.transport({
                      message: messageFrom(cause, `${method} failed`),
                    }),
              ),
              Effect.andThen(
                Effect.fail(
                  AttemptFailure.transport({
                    message: `${method} connection closed`,
                  }),
                ),
              ),
            );

            return yield* pipe(
              Effect.raceFirst(Deferred.await(result), exchange),
              Effect.timeoutOrElse({
                duration: requestTimeoutMillis,
                orElse: () =>
                  Effect.fail(
                    AttemptFailure.transport({
                      message: `${method} timed out`,
                    }),
                  ),
              }),
            );
          }),
          Effect.scoped,
          Effect.mapError(
            (cause): AttemptFailure =>
              Predicate.isTagged(cause, "transport") ||
              Predicate.isTagged(cause, "response")
                ? cause
                : AttemptFailure.transport({
                    message: messageFrom(cause, `${method} failed`),
                  }),
          ),
          Effect.retry({
            while: (failure) => Predicate.isTagged(failure, "transport"),
            times: requestRetries,
            schedule: retrySchedule,
          }),
          Effect.mapError(
            (failure) => new Failure({ message: failure.message }),
          ),
        ),
    );

    return Service.of({
      session: Effect.fn("Shell.Herdr.Repo.session")(function* (socketPath) {
        const result = yield* call(
          socketPath,
          "session.snapshot",
          {},
          SessionResultSchema,
        );
        return result.snapshot;
      }),
      pane: Effect.fn("Shell.Herdr.Repo.pane")(
        function* (socketPath, terminalId) {
          const result = yield* call(
            socketPath,
            "session.snapshot",
            {},
            SessionResultSchema,
          );
          return Option.fromUndefinedOr(
            result.snapshot.panes.find(
              (pane) => pane.terminal_id === terminalId,
            ),
          );
        },
      ),
      read: Effect.fn("Shell.Herdr.Repo.read")(
        function* (socketPath, paneId, lines) {
          const result = yield* call(
            socketPath,
            "pane.read",
            {
              pane_id: paneId,
              source: lines === null ? "visible" : "recent_unwrapped",
              lines: lines ?? undefined,
              format: "text",
              strip_ansi: true,
            },
            ReadResultSchema,
          );
          return result.read;
        },
      ),
      processInfo: Effect.fn("Shell.Herdr.Repo.processInfo")(
        function* (socketPath, paneId) {
          const result = yield* call(
            socketPath,
            "pane.process_info",
            { pane_id: paneId },
            ProcessInfoResultSchema,
          );
          return {
            shellPid: result.process_info.shell_pid,
            foregroundProcessGroup:
              result.process_info.foreground_process_group_id,
            foregroundProcesses: result.process_info.foreground_processes ?? [],
          };
        },
      ),
      createWorkspace: Effect.fn("Shell.Herdr.Repo.createWorkspace")(
        function* (socketPath, cwd, env) {
          const result = yield* call(
            socketPath,
            "workspace.create",
            { cwd, env, focus: false },
            WorkspaceResultSchema,
          );
          return result.root_pane;
        },
      ),
      sendText: Effect.fn("Shell.Herdr.Repo.sendText")(
        function* (socketPath, paneId, text) {
          yield* call(
            socketPath,
            "pane.send_text",
            { pane_id: paneId, text },
            Schema.Unknown,
          );
        },
      ),
      reportAgent: Effect.fn("Shell.Herdr.Repo.reportAgent")(
        function* (socketPath, paneId, source, agent, state) {
          yield* call(
            socketPath,
            "pane.report_agent",
            { pane_id: paneId, source, agent, state },
            Schema.Unknown,
          );
        },
      ),
      releaseAgent: Effect.fn("Shell.Herdr.Repo.releaseAgent")(
        function* (socketPath, paneId, source, agent) {
          yield* call(
            socketPath,
            "pane.release_agent",
            { pane_id: paneId, source, agent },
            Schema.Unknown,
          );
        },
      ),
      ping: Effect.fn("Shell.Herdr.Repo.ping")(function* (socketPath) {
        yield* call(socketPath, "ping", {}, Schema.Unknown);
      }),
      stop: Effect.fn("Shell.Herdr.Repo.stop")(function* (socketPath) {
        yield* call(socketPath, "server.stop", {}, Schema.Unknown);
      }),
    });
  }),
);

export * as Repo from "./repo.ts";
