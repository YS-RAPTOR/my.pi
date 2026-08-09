import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  pipe,
  Predicate,
  Ref,
  Result,
} from "effect";
import { Config } from "#s/config";
import {
  type Lifecycle as LifecycleValue,
  Lifecycle,
  ResourceId,
  ResourceNotFound,
  ResourceSummary,
  SignalFailed,
  SnapshotFailed,
  StdinClosed,
  TerminalSnapshot,
} from "../types.ts";
import type { Launch } from "./private.ts";
import { Repo } from "./repo.ts";

type State = Readonly<{
  lifecycle: LifecycleValue;
  snapshot: TerminalSnapshot | undefined;
  signalSnapshot: TerminalSnapshot | undefined;
}>;

export type Metadata = Readonly<{
  driver: Resource["driver"];
  socketPath: string;
  pane: Repo.Pane;
  launch?: Launch;
  cmd: string;
  cwd: string;
  workspace?: string;
}>;

export type Resource = Readonly<{
  driver: "pty" | "herdr";
  supervise: (id: ResourceId) => Effect.Effect<void>;
  inspect: (
    id: ResourceId,
  ) => Effect.Effect<Option.Option<ResourceSummary>>;
  snapshot: (
    id: ResourceId,
    lines: number | null,
  ) => Effect.Effect<TerminalSnapshot, SnapshotFailed | ResourceNotFound>;
  write: (
    id: ResourceId,
    text: string,
  ) => Effect.Effect<void, ResourceNotFound | StdinClosed>;
  signal: (
    id: ResourceId,
    signal: string,
  ) => Effect.Effect<void, ResourceNotFound | SignalFailed>;
  wait: (
    id: ResourceId,
    yieldAfter: number,
  ) => Effect.Effect<boolean, ResourceNotFound>;
}>;

export type Interface = Readonly<{
  create: (metadata: Metadata) => Effect.Effect<Resource>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Shell.Herdr.Terminal",
) {}

const terminal = (lifecycle: LifecycleValue) =>
  Predicate.isTagged(lifecycle, "completed") ||
  Predicate.isTagged(lifecycle, "failed");

const foregroundJob = (info: Repo.ProcessInfo) =>
  info.foregroundProcesses.some((process) => process.pid !== info.shellPid)
    ? info.foregroundProcessGroup
    : undefined;

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = (yield* Config.Service).shell.herdr;
    const repo = yield* Repo.Service;

    const create: Interface["create"] = Effect.fn(
      "Shell.Herdr.Terminal.create",
    )(function* (metadata) {
      const startedAt = yield* Clock.currentTimeMillis;
      const state = yield* Ref.make<State>({
        lifecycle: Lifecycle.running(),
        snapshot: undefined,
        signalSnapshot: undefined,
      });
      const completion = yield* Deferred.make<void>();
      const terminalId = metadata.pane.terminal_id;

      const pane = Effect.fn("Shell.Herdr.Terminal.__pane")(
        function* (id: ResourceId) {
          const found = yield* pipe(
            repo.pane(metadata.socketPath, terminalId),
            Effect.mapError(() => new ResourceNotFound({ resourceId: id })),
          );
          if (Option.isNone(found)) {
            return yield* new ResourceNotFound({ resourceId: id });
          }
          return found.value;
        },
      );

      const capture = Effect.fn("Shell.Herdr.Terminal.__capture")(
        function* (id: ResourceId, lines: number | null) {
          const current = yield* Ref.get(state);
          if (terminal(current.lifecycle) && current.snapshot !== undefined)
            return current.snapshot;

          const currentPane = yield* pane(id);
          const read = yield* pipe(
            repo.read(metadata.socketPath, currentPane.pane_id, lines),
            Effect.mapError(
              (failure) =>
                new SnapshotFailed({
                  resourceId: id,
                  message: failure.message,
                }),
            ),
          );
          const latest = yield* Ref.get(state);
          const snapshot = new TerminalSnapshot({
            resourceId: id,
            text: read.text,
            revision: read.revision,
            truncated: read.truncated,
            lifecycle: latest.lifecycle,
          });
          yield* Ref.update(state, (value) => ({ ...value, snapshot }));
          return snapshot;
        },
      );

      const finish = Effect.fn("Shell.Herdr.Terminal.__finish")(
        function* (
          id: ResourceId,
          status: Readonly<{
            exitCode: number | null;
            signal: string | null;
          }>,
          captured: TerminalSnapshot,
        ) {
          const current = yield* Ref.get(state);
          const lifecycle = Lifecycle.completed({
            exitCode: status.exitCode,
            signal: status.signal,
          });
          const snapshot = new TerminalSnapshot({
            resourceId: id,
            text: captured.text,
            revision: captured.revision,
            truncated: captured.truncated,
            lifecycle,
          });
          yield* Ref.set(state, { ...current, lifecycle, snapshot });
          yield* Deferred.succeed(completion, undefined);
        },
      );

      const fail = Effect.fn("Shell.Herdr.Terminal.__fail")(
        function* (id: ResourceId, message: string) {
          const current = yield* Ref.get(state);
          const lifecycle = Lifecycle.failed({ message });
          const snapshot = new TerminalSnapshot({
            resourceId: id,
            text: current.snapshot?.text ?? "",
            revision: current.snapshot?.revision ?? 0,
            truncated: current.snapshot?.truncated ?? false,
            lifecycle,
          });
          yield* Ref.set(state, { ...current, lifecycle, snapshot });
          yield* Deferred.succeed(completion, undefined);
        },
      );

      const supervise = Effect.fn(
        "Shell.Herdr.Terminal.supervise",
      )(function* (id: ResourceId) {
        if (metadata.driver !== "pty") return;
        if (metadata.launch === undefined) {
          yield* fail(id, "The private terminal has no launcher control");
          return;
        }

        const reported = yield* Effect.result(metadata.launch.exit);
        if (!Result.isSuccess(reported)) {
          yield* fail(id, reported.failure.message);
          yield* metadata.launch.release;
          return;
        }

        yield* Ref.update(state, (current) => ({
          ...current,
          lifecycle: Lifecycle.draining({
            exitCode: reported.success.exitCode,
            signal: reported.success.signal,
          }),
        }));
        const current = yield* Ref.get(state);
        const captured =
          reported.success.signal !== null &&
          current.signalSnapshot !== undefined
            ? Result.succeed(current.signalSnapshot)
            : yield* Effect.result(capture(id, 1_000));
        if (Result.isSuccess(captured)) {
          yield* finish(id, reported.success, captured.success);
        } else {
          yield* fail(id, captured.failure.message);
        }
        yield* metadata.launch.release;
      });

      const inspect = Effect.fn("Shell.Herdr.Terminal.inspect")(
        function* (id: ResourceId) {
          const current = yield* Ref.get(state);
          if (metadata.driver === "herdr") {
            const exists = yield* Effect.result(
              repo.pane(metadata.socketPath, terminalId),
            );
            if (Result.isSuccess(exists) && Option.isNone(exists.success))
              return Option.none();
          }
          return Option.some(
            new ResourceSummary({
              resourceId: id,
              cmd: metadata.cmd,
              cwd: metadata.cwd,
              ...(metadata.workspace === undefined
                ? {}
                : { workspace: metadata.workspace }),
              lifecycle: current.lifecycle,
              startedAt,
            }),
          );
        },
      );

      const snapshot = Effect.fn("Shell.Herdr.Terminal.snapshot")(
        function* (id: ResourceId, lines: number | null) {
          return yield* capture(id, lines);
        },
      );

      const write = Effect.fn("Shell.Herdr.Terminal.write")(
        function* (id: ResourceId, text: string) {
          const current = yield* Ref.get(state);
          if (terminal(current.lifecycle)) {
            return yield* new StdinClosed({ resourceId: id });
          }
          const currentPane = yield* pane(id);
          yield* pipe(
            repo.sendText(metadata.socketPath, currentPane.pane_id, text),
            Effect.mapError(() => new StdinClosed({ resourceId: id })),
          );
        },
      );

      const signal = Effect.fn("Shell.Herdr.Terminal.signal")(
        function* (id: ResourceId, requestedSignal: string) {
          const current = yield* Ref.get(state);
          if (!Predicate.isTagged(current.lifecycle, "running")) {
            return yield* new SignalFailed({
              resourceId: id,
              message: "The shell command is no longer running",
            });
          }
          let processGroup: number | undefined;
          if (metadata.driver === "pty") {
            if (metadata.launch === undefined) {
              return yield* new SignalFailed({
                resourceId: id,
                message: "The private terminal has no launcher control",
              });
            }
            const captured = yield* pipe(
              capture(id, 1_000),
              Effect.mapError(
                (failure) =>
                  new SignalFailed({
                    resourceId: id,
                    message: messageFrom(
                      failure,
                      `Unable to capture before ${requestedSignal}`,
                    ),
                  }),
              ),
            );
            yield* Ref.update(state, (value) => ({
              ...value,
              signalSnapshot: captured,
            }));
            processGroup = metadata.launch.processGroup;
          } else {
            const currentPane = yield* pane(id);
            const info = yield* pipe(
              repo.processInfo(metadata.socketPath, currentPane.pane_id),
              Effect.mapError(
                (failure) =>
                  new SignalFailed({
                    resourceId: id,
                    message: failure.message,
                  }),
              ),
            );
            processGroup = foregroundJob(info);
            if (processGroup === undefined) {
              return yield* new SignalFailed({
                resourceId: id,
                message: "The terminal has no foreground command",
              });
            }
          }
          yield* Effect.try({
            try: () =>
              process.kill(
                -processGroup,
                requestedSignal as NodeJS.Signals,
              ),
            catch: (cause) =>
              new SignalFailed({
                resourceId: id,
                message: messageFrom(
                  cause,
                  `Unable to deliver ${requestedSignal}`,
                ),
              }),
          });
        },
      );

      const waitForForeground = Effect.fn(
        "Shell.Herdr.Terminal.__waitForForeground",
      )(function* (id: ResourceId, processGroup: number) {
        while (true) {
          const currentPane = yield* pane(id);
          const info = yield* Effect.result(
            repo.processInfo(metadata.socketPath, currentPane.pane_id),
          );
          if (!Result.isSuccess(info)) {
            yield* Effect.sleep(Duration.millis(config.waitPollMillis));
            continue;
          }
          if (info.success.foregroundProcessGroup !== processGroup) return;
          yield* Effect.sleep(Duration.millis(config.waitPollMillis));
        }
      });

      const wait = Effect.fn("Shell.Herdr.Terminal.wait")(
        function* (id: ResourceId, yieldAfter: number) {
          if (metadata.driver === "pty") {
            const completed = Effect.map(Ref.get(state), (current) =>
              Predicate.isTagged(current.lifecycle, "completed"),
            );
            const current = yield* Ref.get(state);
            if (terminal(current.lifecycle)) return yield* completed;
            return yield* Effect.raceFirst(
              Effect.andThen(Deferred.await(completion), completed),
              Effect.as(Effect.sleep(Duration.seconds(yieldAfter)), false),
            );
          }

          const currentPane = yield* pane(id);
          const info = yield* pipe(
            repo.processInfo(metadata.socketPath, currentPane.pane_id),
            Effect.mapError(() => new ResourceNotFound({ resourceId: id })),
          );
          const processGroup = foregroundJob(info);
          if (processGroup === undefined) return true;
          return yield* Effect.raceFirst(
            Effect.as(waitForForeground(id, processGroup), true),
            Effect.as(Effect.sleep(Duration.seconds(yieldAfter)), false),
          );
        },
      );

      return {
        driver: metadata.driver,
        supervise,
        inspect,
        snapshot,
        write,
        signal,
        wait,
      };
    });

    return Service.of({ create });
  }),
);

export * as Terminal from "./terminal.ts";
