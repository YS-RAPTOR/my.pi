import type { Data } from "effect";
import { NodeSocket } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  pipe,
  Predicate,
  Schedule,
} from "effect";
import { Config } from "#s/config";

type ApiResponse = Readonly<{
  result?: unknown;
  error?: Readonly<{ message: string }>;
}>;

export type Failure = Readonly<{ message: string }>;

type AttemptFailure = Data.TaggedEnum<{
  transport: Failure;
  response: Failure;
}>;

const attemptFailure = {
  transport: (message: string): AttemptFailure => ({
    _tag: "transport",
    message,
  }),
  response: (message: string): AttemptFailure => ({
    _tag: "response",
    message,
  }),
};

const isAttemptFailure = (cause: unknown): cause is AttemptFailure =>
  Predicate.isTagged(cause, "transport") ||
  Predicate.isTagged(cause, "response");

export type Workspace = Readonly<{
  workspace_id: string;
  label: string;
}>;

export type Pane = Readonly<{
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  cwd?: string;
  foreground_cwd?: string;
  title?: string;
  terminal_title_stripped?: string;
}>;

export type SessionSnapshot = Readonly<{
  workspaces: ReadonlyArray<Workspace>;
  panes: ReadonlyArray<Pane>;
}>;

export type PaneRead = Readonly<{
  text: string;
  revision: number;
  truncated: boolean;
}>;

export type ProcessInfo = Readonly<{
  shellPid: number | undefined;
  foregroundProcessGroup: number | undefined;
  foregroundProcesses: ReadonlyArray<Readonly<{ pid: number }>>;
}>;

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
  ping: (socketPath: string) => Effect.Effect<void, Failure>;
  stop: (socketPath: string) => Effect.Effect<void, Failure>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Shell.Herdr.Repo",
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
      <A>(socketPath: string, method: string, params: unknown) =>
        pipe(
          Effect.gen(function* () {
            const socket = yield* NodeSocket.makeNet({
              path: socketPath,
              openTimeout: requestTimeoutMillis,
            });
            const write = yield* socket.writer;
            const result = yield* Deferred.make<A, AttemptFailure>();
            const decoder = new TextDecoder();
            let response = "";

            const exchange = pipe(
              Effect.all(
                [
                  socket.run((chunk) => {
                    response += decoder.decode(chunk, { stream: true });
                    if (Buffer.byteLength(response) > maximumMessageBytes) {
                      return Deferred.fail(
                        result,
                        attemptFailure.response(
                          `${method} response exceeds ${maximumMessageBytes} bytes`,
                        ),
                      );
                    }
                    const newline = response.indexOf("\n");
                    if (newline === -1) return;
                    try {
                      const decoded = JSON.parse(
                        response.slice(0, newline),
                      ) as ApiResponse;
                      return decoded.error === undefined
                        ? Deferred.succeed(result, decoded.result as A)
                        : Deferred.fail(
                            result,
                            attemptFailure.response(decoded.error.message),
                          );
                    } catch (cause) {
                      return Deferred.fail(
                        result,
                        attemptFailure.response(
                          messageFrom(cause, `${method} returned invalid JSON`),
                        ),
                      );
                    }
                  }),
                  write(`${JSON.stringify({ id: method, method, params })}\n`),
                ],
                { concurrency: "unbounded", discard: true },
              ),
              Effect.mapError((cause) =>
                attemptFailure.transport(
                  messageFrom(cause, `${method} failed`),
                ),
              ),
              Effect.andThen(
                Effect.fail(
                  attemptFailure.transport(`${method} connection closed`),
                ),
              ),
            );

            return yield* pipe(
              Effect.raceFirst(Deferred.await(result), exchange),
              Effect.timeoutOrElse({
                duration: requestTimeoutMillis,
                orElse: () =>
                  Effect.fail(attemptFailure.transport(`${method} timed out`)),
              }),
            );
          }),
          Effect.scoped,
          Effect.mapError(
            (cause): AttemptFailure =>
              isAttemptFailure(cause)
                ? cause
                : attemptFailure.transport(
                    messageFrom(cause, `${method} failed`),
                  ),
          ),
          Effect.retry({
            while: (failure) => Predicate.isTagged(failure, "transport"),
            times: requestRetries,
            schedule: retrySchedule,
          }),
          Effect.mapError((failure): Failure => ({ message: failure.message })),
        ),
    );

    return Service.of({
      session: Effect.fn("Shell.Herdr.Repo.session")(function* (socketPath) {
        const result = yield* call<
          Readonly<{
            snapshot: SessionSnapshot;
          }>
        >(socketPath, "session.snapshot", {});
        return result.snapshot;
      }),
      pane: Effect.fn("Shell.Herdr.Repo.pane")(
        function* (socketPath, terminalId) {
          const snapshot = yield* call<
            Readonly<{
              snapshot: SessionSnapshot;
            }>
          >(socketPath, "session.snapshot", {});
          return Option.fromUndefinedOr(
            snapshot.snapshot.panes.find(
              (pane) => pane.terminal_id === terminalId,
            ),
          );
        },
      ),
      read: Effect.fn("Shell.Herdr.Repo.read")(
        function* (socketPath, paneId, lines) {
          const result = yield* call<
            Readonly<{
              read: PaneRead;
            }>
          >(socketPath, "pane.read", {
            pane_id: paneId,
            source: lines === null ? "visible" : "recent_unwrapped",
            lines: lines ?? undefined,
            format: "text",
            strip_ansi: true,
          });
          return result.read;
        },
      ),
      processInfo: Effect.fn("Shell.Herdr.Repo.processInfo")(
        function* (socketPath, paneId) {
          const result = yield* call<
            Readonly<{
              process_info: Readonly<{
                shell_pid?: number;
                foreground_process_group_id?: number;
                foreground_processes?: ReadonlyArray<Readonly<{ pid: number }>>;
              }>;
            }>
          >(socketPath, "pane.process_info", { pane_id: paneId });
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
          const result = yield* call<Readonly<{ root_pane: Pane }>>(
            socketPath,
            "workspace.create",
            { cwd, env, focus: false },
          );
          return result.root_pane;
        },
      ),
      sendText: Effect.fn("Shell.Herdr.Repo.sendText")(
        function* (socketPath, paneId, text) {
          yield* call(socketPath, "pane.send_text", {
            pane_id: paneId,
            text,
          });
        },
      ),
      ping: Effect.fn("Shell.Herdr.Repo.ping")(function* (socketPath) {
        yield* call(socketPath, "ping", {});
      }),
      stop: Effect.fn("Shell.Herdr.Repo.stop")(function* (socketPath) {
        yield* call(socketPath, "server.stop", {});
      }),
    });
  }),
);

export * as Repo from "./repo.ts";
