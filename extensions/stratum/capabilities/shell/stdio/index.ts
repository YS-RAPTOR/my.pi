import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  HashSet,
  Layer,
  Option,
  Path,
  pipe,
  PlatformError,
  Predicate,
  Queue,
  Record,
  Ref,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Session } from "#s/common/session";
import { Config } from "#s/config";
import type { Open } from "../types.ts";
import {
  Lifecycle,
  OpenFailed,
  ResourceId,
  ResourceSummary,
  SignalFailed,
  StdinClosed,
} from "../types.ts";

type ProcessExit = Readonly<{
  exitCode: number | null;
  signal: string | null;
}>;

type State = Readonly<{
  lifecycle: typeof Lifecycle.Type;
  owners: HashSet.HashSet<string>;
  lastInteraction: number;
}>;

export type Resource = Readonly<{
  outputFile: string;
  write: (
    id: ResourceId,
    session: Session.ID,
    bytes: Uint8Array,
  ) => Effect.Effect<void, StdinClosed>;
  signal: (
    id: ResourceId,
    session: Session.ID,
    signal: string,
  ) => Effect.Effect<void, SignalFailed>;
  inspect: (
    id: ResourceId,
    session: Session.ID,
  ) => Effect.Effect<Option.Option<ResourceSummary>>;
  closeStdin: (session: Session.ID) => Effect.Effect<void>;
  wait: (
    id: ResourceId,
    session: Session.ID,
    yieldAfter: number,
  ) => Effect.Effect<boolean>;
}>;

export type Interface = Readonly<{
  open: (
    session: Session.ID,
    command: Open,
  ) => Effect.Effect<Resource, OpenFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Shell.Stdio",
) {}

const terminal = (lifecycle: typeof Lifecycle.Type) =>
  Predicate.isTagged(lifecycle, "completed") ||
  Predicate.isTagged(lifecycle, "failed");

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const signalFrom = (failure: PlatformError.PlatformError) => {
  const { reason } = failure;
  if (!Predicate.hasProperty(reason, "cause")) return null;
  if (!Predicate.isError(reason.cause)) return null;
  return (
    reason.cause.message.match(/receipt of signal: '([^']+)'/)?.[1] ?? null
  );
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = (yield* Config.Service).shell.stdio;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const open = Effect.fn("Shell.Stdio.open")(function* (
      session: Session.ID,
      command: Open,
    ) {
      const resourceScope = yield* Scope.fork(scope, "parallel");
      return yield* Effect.uninterruptibleMask((restore) =>
        pipe(
          Effect.gen(function* () {
            const directory = yield* restore(
              fileSystem.makeTempDirectory({ prefix: "stratum-shell-" }),
            );
            yield* restore(fileSystem.chmod(directory, 0o700));
            const outputFile = path.join(directory, "output.log");
            const log = yield* pipe(
              fileSystem.open(outputFile, { flag: "wx", mode: 0o600 }),
              Scope.provide(resourceScope),
              restore,
            );
            const handle = yield* pipe(
              spawner.spawn(
                ChildProcess.make("/bin/bash", ["-c", command.cmd], {
                  cwd: command.cwd,
                  env: Record.map(
                    command.env ?? {},
                    (value) => value ?? undefined,
                  ),
                  extendEnv: true,
                  stdin: { stream: "pipe", endOnDone: true },
                }),
              ),
              Scope.provide(resourceScope),
              restore,
            );
            const now = yield* Clock.currentTimeMillis;
            const state = yield* Ref.make<State>({
              lifecycle: Lifecycle.make({ _tag: "running" }),
              owners: HashSet.make(session.value),
              lastInteraction: now,
            });
            const completion = yield* Deferred.make<void>();
            const stdin = yield* Queue.bounded<Uint8Array, Cause.Done>(
              config.stdinCapacity,
            );

            const setLifecycle = Effect.fn("Shell.Stdio.__setLifecycle")(
              function* (lifecycle: typeof Lifecycle.Type) {
                yield* Ref.update(state, (current) => ({
                  ...current,
                  lifecycle,
                }));
                if (terminal(lifecycle)) {
                  yield* Deferred.succeed(completion, undefined);
                }
              },
            );

            const touch = Effect.fn("Shell.Stdio.__touch")(
              (owner: Session.ID) =>
                Effect.gen(function* () {
                  const lastInteraction = yield* Clock.currentTimeMillis;
                  yield* Ref.update(state, (current) => ({
                    ...current,
                    owners: HashSet.add(current.owners, owner.value),
                    lastInteraction,
                  }));
                }),
            );

            const endStdin = Queue.end(stdin).pipe(Effect.asVoid);

            const write = Effect.fn("Shell.Stdio.write")(function* (
              id: ResourceId,
              owner: Session.ID,
              bytes: Uint8Array,
            ) {
              yield* touch(owner);
              if (yield* Queue.offer(stdin, bytes)) return;
              return yield* new StdinClosed({ resource_id: id });
            });

            const closeStdin = Effect.fn("Shell.Stdio.closeStdin")(
              (owner: Session.ID) =>
                pipe(touch(owner), Effect.andThen(endStdin)),
            );

            const signal = Effect.fn("Shell.Stdio.signal")(function* (
              id: ResourceId,
              owner: Session.ID,
              requested: string,
            ) {
              yield* touch(owner);
              yield* Effect.try({
                try: () => {
                  const nodeSignal = requested as NodeJS.Signals;
                  if (process.platform !== "win32") {
                    try {
                      process.kill(-handle.pid, nodeSignal);
                      return;
                    } catch {}
                  }
                  process.kill(handle.pid, nodeSignal);
                },
                catch: (cause) =>
                  new SignalFailed({
                    resource_id: id,
                    message: messageFrom(
                      cause,
                      `Unable to deliver ${requested}`,
                    ),
                  }),
              });
            });

            const wait = Effect.fn("Shell.Stdio.wait")(function* (
              _id: ResourceId,
              owner: Session.ID,
              yieldAfter: number,
            ) {
              yield* touch(owner);
              const current = yield* Ref.get(state);
              if (terminal(current.lifecycle)) return true;
              return yield* Effect.raceFirst(
                Effect.as(Deferred.await(completion), true),
                Effect.as(Effect.sleep(Duration.seconds(yieldAfter)), false),
              );
            });

            const inspect = Effect.fn("Shell.Stdio.inspect")(function* (
              id: ResourceId,
              owner: Session.ID,
            ) {
              const current = yield* Ref.get(state);
              if (!HashSet.has(current.owners, owner.value)) {
                return Option.none();
              }
              return Option.some(
                new ResourceSummary({
                  resource_id: id,
                  cmd: command.cmd,
                  cwd: command.cwd,
                  lifecycle: current.lifecycle,
                  output_file: outputFile,
                  started_at: now,
                  last_interaction: current.lastInteraction,
                }),
              );
            });

            const supervise = Effect.fn("Shell.Stdio.__supervise")(
              function* () {
                yield* pipe(
                  Stream.fromQueue(stdin),
                  Stream.run(handle.stdin),
                  Effect.ensuring(endStdin),
                  Effect.ignore,
                  Effect.forkChild,
                );
                return yield* Effect.all(
                  [
                    pipe(
                      handle.exitCode,
                      Effect.map((code): ProcessExit => ({
                        exitCode: Number(code),
                        signal: null,
                      })),
                      Effect.catch((failure) => {
                        const signal = signalFrom(failure);
                        return signal === null
                          ? Effect.fail(failure)
                          : Effect.succeed<ProcessExit>({
                              exitCode: null,
                              signal,
                            });
                      }),
                      Effect.tap((result) =>
                        pipe(
                          setLifecycle(
                            Lifecycle.make({
                              _tag: "draining",
                              exit_code: result.exitCode,
                              signal: result.signal,
                            }),
                          ),
                          Effect.andThen(endStdin),
                        ),
                      ),
                    ),
                    pipe(
                      Stream.merge(handle.stdout, handle.stderr),
                      Stream.filter((bytes) => bytes.byteLength > 0),
                      Stream.runForEach((bytes) => log.writeAll(bytes)),
                    ),
                  ],
                  { concurrency: "unbounded" },
                );
              },
            );

            yield* pipe(
              supervise(),
              Effect.map(([exit]) => exit),
              Effect.tap(() => log.sync),
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  setLifecycle(
                    Lifecycle.make({
                      _tag: "failed",
                      message: Cause.pretty(cause),
                    }),
                  ),
                onSuccess: (exit) =>
                  setLifecycle(
                    Lifecycle.make({
                      _tag: "completed",
                      exit_code: exit.exitCode,
                      signal: exit.signal,
                    }),
                  ),
              }),
              Effect.ensuring(
                pipe(
                  endStdin,
                  Effect.andThen(Scope.close(resourceScope, Exit.void)),
                ),
              ),
              Effect.forkIn(scope, { startImmediately: true }),
            );

            return { outputFile, write, closeStdin, signal, wait, inspect };
          }),
          Effect.mapError(
            (cause) =>
              new OpenFailed({
                message: messageFrom(cause, "Unable to open the shell process"),
              }),
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Scope.close(resourceScope, exit)
              : Effect.void,
          ),
        ),
      );
    });

    return Service.of({ open });
  }),
);

export * as Stdio from "./index.ts";
