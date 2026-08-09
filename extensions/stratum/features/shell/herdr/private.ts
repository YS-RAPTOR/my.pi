import { NodeSocketServer } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Match,
  Path,
  pipe,
  Result,
  Schema,
  Scope,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Socket from "effect/unstable/socket/Socket";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Config } from "#s/config";
import type { Open } from "../types.ts";
import { PtyUnavailable } from "../types.ts";
import { Repo } from "./repo.ts";

const launcherSourcePath = fileURLToPath(
  new URL("./launcher.py", import.meta.url),
);

const LauncherOptions = Schema.Struct({
  connectionRetries: Schema.Int,
  connectionRetryMillis: Schema.Int,
  connectionTimeoutMillis: Schema.Int,
  releaseTimeoutMillis: Schema.Int,
});
const encodeJsonString = Schema.encodeSync(
  Schema.fromJsonString(Schema.String),
);
const encodeLauncherOptions = Schema.encodeSync(
  Schema.fromJsonString(LauncherOptions),
);

const configuration = (launcherPath: string) => `
onboarding = false

[terminal]
default_shell = ${encodeJsonString(launcherPath)}
shell_mode = "non_login"

[ui]
sidebar_start_collapsed = true
sidebar_collapsed_mode = "hidden"
hide_tab_bar_when_single_tab = true

[update]
version_check = false
manifest_check = false
`;

const launcherScript = (
  source: string,
  config: Config.Value["shell"]["herdr"],
) => {
  const options = encodeLauncherOptions({
    connectionRetries: config.requestRetries,
    connectionRetryMillis: config.requestRetryMillis,
    connectionTimeoutMillis: config.requestTimeoutMillis,
    releaseTimeoutMillis:
      config.requestTimeoutMillis * (config.requestRetries + 1) +
      config.requestRetryMillis * config.requestRetries +
      config.shutdownTimeoutMillis,
  });
  return `#!/usr/bin/env python3\n${source}\n\nraise SystemExit(main(json.loads(${encodeJsonString(options)})))\n`;
};

const Started = Schema.TaggedStruct("Started", {
  commandId: Schema.NonEmptyString,
  processGroup: Schema.Int.check(Schema.isGreaterThan(0)),
});

const StartFailed = Schema.TaggedStruct("StartFailed", {
  commandId: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
});

const Exited = Schema.TaggedStruct("Exited", {
  commandId: Schema.NonEmptyString,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.NonEmptyString),
});

const Release = Schema.TaggedStruct("Release", {});

const Descriptor = Schema.Struct({
  commandId: Schema.NonEmptyString,
  controlSocket: Schema.NonEmptyString,
  cmd: Schema.String,
  cwd: Schema.NonEmptyString,
  env: Schema.Record(Schema.String, Schema.String),
});

const releaseMessage = `${Schema.encodeSync(
  Schema.fromJsonString(Release),
)(Release.make({}))}\n`;
const LauncherReport = Schema.Union([Started, StartFailed, Exited]);
const decodeLauncherReport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LauncherReport),
);
const encodeDescriptor = Schema.encodeEffect(Schema.fromJsonString(Descriptor));

export type ExitStatus = Readonly<{
  exitCode: number | null;
  signal: string | null;
}>;

export type LaunchFailure = Readonly<{
  message: string;
}>;

export type Launch = Readonly<{
  processGroup: number;
  exit: Effect.Effect<ExitStatus, LaunchFailure>;
  release: Effect.Effect<void>;
}>;

export type Opened = Readonly<{
  socketPath: string;
  pane: Repo.Pane;
  launch: Launch;
}>;

export type Interface = Readonly<{
  open: (command: Open) => Effect.Effect<Opened, PtyUnavailable>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Shell.Herdr.Private",
) {}

type StartupFailure = LaunchFailure & Readonly<{ release?: boolean }>;

type Pending = Readonly<{
  commandId: string;
  started: Deferred.Deferred<typeof Started.Type, StartupFailure>;
  exited: Deferred.Deferred<ExitStatus, LaunchFailure>;
  action: Deferred.Deferred<boolean>;
}>;

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = (yield* Config.Service).shell.herdr;
    const path = yield* Path.Path;
    const repo = yield* Repo.Service;
    const scope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const registry = new Map<string, Pending>();

    const register = Effect.fn("Shell.Herdr.Private.__register")(
      function* (commandId: string) {
        const pending: Pending = {
          commandId,
          started: yield* Deferred.make<
            typeof Started.Type,
            StartupFailure
          >(),
          exited: yield* Deferred.make<ExitStatus, LaunchFailure>(),
          action: yield* Deferred.make<boolean>(),
        };
        yield* Effect.sync(() => registry.set(commandId, pending));
        return pending;
      },
    );

    const complete = Effect.fn("Shell.Herdr.Private.__complete")(
      function* (pending: Pending, release: boolean) {
        yield* Deferred.succeed(pending.action, release);
        yield* Effect.sync(() => registry.delete(pending.commandId));
      },
    );

    const decodeReport = Effect.fn(
      "Shell.Herdr.Private.__decodeReport",
    )((line: string) =>
      pipe(
        decodeLauncherReport(line),
        Effect.mapError(
          (cause): LaunchFailure => ({
            message: messageFrom(cause, "Invalid launcher report"),
          }),
        ),
      ),
    );

    const handleConnection = Effect.fn(
      "Shell.Herdr.Private.__handleConnection",
    )(function* (socket: Socket.Socket) {
      const write = yield* socket.writer;
      const decoder = new TextDecoder();
      let buffer = "";
      let pending: Pending | undefined;

      const dispatch = Effect.fn("Shell.Herdr.Private.__dispatch")(
        function* (report: typeof LauncherReport.Type) {
          if (pending === undefined) {
            pending = registry.get(report.commandId);
            if (pending === undefined) {
              return yield* Effect.fail<LaunchFailure>({
                message: "Unknown launcher command",
              });
            }
            yield* pipe(
              Deferred.await(pending.action),
              Effect.flatMap((release) =>
                release
                  ? write(releaseMessage)
                  : write(
                      new Socket.CloseEvent(
                        1011,
                        "Stratum command launch was abandoned",
                      ),
                    ),
              ),
              Effect.ignore,
              Effect.forkChild,
            );
          }
          if (pending.commandId !== report.commandId) {
            return yield* Effect.fail<LaunchFailure>({
              message: "Launcher connection changed command identity",
            });
          }
          const current = pending;
          return yield* Match.value(report).pipe(
            Match.tagsExhaustive({
              Started: (started) => Deferred.succeed(current.started, started),
              StartFailed: (failure) =>
                Effect.all(
                  [
                    Deferred.fail(current.started, {
                      message: failure.message,
                      release: true,
                    }),
                    Deferred.fail(current.exited, {
                      message: failure.message,
                    }),
                  ],
                  { discard: true },
                ),
              Exited: (exited) => {
                if ((exited.exitCode === null) === (exited.signal === null)) {
                  return Effect.fail<LaunchFailure>({
                    message: "Launcher exit report has ambiguous status",
                  });
                }
                return Deferred.succeed(current.exited, {
                  exitCode: exited.exitCode,
                  signal: exited.signal,
                });
              },
            }),
          );
        },
      );

      const onChunk = (chunk: Uint8Array) => {
        buffer += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(buffer) > config.maximumMessageBytes) {
          return Effect.fail<LaunchFailure>({
            message: "Launcher report exceeds the configured limit",
          });
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        return Effect.forEach(
          lines,
          (line) => pipe(decodeReport(line), Effect.flatMap(dispatch)),
          { discard: true },
        );
      };

      return yield* pipe(
        socket.run(onChunk),
        Effect.ensuring(
          Effect.suspend(() => {
            if (pending === undefined) return Effect.void;
            const failure: LaunchFailure = {
              message: "Launcher control connection closed unexpectedly",
            };
            return Effect.all(
              [
                Deferred.fail(pending.started, failure),
                Deferred.fail(pending.exited, failure),
              ],
              { discard: true },
            );
          }),
        ),
      );
    });

    const start = Effect.fn("Shell.Herdr.Private.__start")(
      function* () {
        const root = yield* fileSystem.makeTempDirectory({
          prefix: "stratum-herdr-",
        });
        yield* fileSystem.chmod(root, 0o700);
        yield* Effect.addFinalizer(() =>
          pipe(
            fileSystem.remove(root, { recursive: true, force: true }),
            Effect.ignore,
          ),
        );

        const launcherPath = path.join(root, "launcher");
        const configPath = path.join(root, "config.toml");
        const configHome = path.join(root, "config-home");
        const socketPath = path.join(root, "herdr.sock");
        const controlSocketPath = path.join(root, "control.sock");

        const controlServer = yield* NodeSocketServer.make({
          path: controlSocketPath,
        });
        yield* pipe(
          controlServer.run((socket) =>
            Effect.scoped(handleConnection(socket)),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        );

        yield* fileSystem.makeDirectory(configHome, { recursive: true });
        const launcherSource =
          yield* fileSystem.readFileString(launcherSourcePath);
        yield* fileSystem.writeFileString(
          launcherPath,
          launcherScript(launcherSource, config),
        );
        yield* fileSystem.chmod(launcherPath, 0o700);
        yield* fileSystem.writeFileString(
          configPath,
          configuration(launcherPath),
        );
        yield* fileSystem.chmod(configPath, 0o600);

        const handle = yield* pipe(
          spawner.spawn(
            ChildProcess.make("herdr", ["server"], {
              cwd: root,
              env: {
                HERDR_CONFIG_PATH: configPath,
                HERDR_SESSION: undefined,
                HERDR_SOCKET_PATH: socketPath,
                XDG_CONFIG_HOME: configHome,
              },
              extendEnv: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          ),
          Effect.mapError(
            (cause) =>
              new PtyUnavailable({
                message: messageFrom(cause, "Unable to start Herdr"),
              }),
          ),
        );
        yield* Effect.addFinalizer(() =>
          pipe(
            repo.stop(socketPath),
            Effect.ignore,
            Effect.andThen(handle.kill().pipe(Effect.ignore)),
            Effect.timeout(config.shutdownTimeoutMillis),
            Effect.ignore,
          ),
        );

        let lastFailure = "Herdr did not become ready";
        for (let attempt = 0; attempt < config.startupAttempts; attempt += 1) {
          const result = yield* Effect.result(repo.ping(socketPath));
          if (Result.isSuccess(result)) {
            return { root, socketPath, controlSocketPath };
          }
          lastFailure = result.failure.message;
          yield* Effect.sleep(config.startupPollMillis);
        }
        return yield* new PtyUnavailable({ message: lastFailure });
      },
    );

    const runtime = yield* Effect.cached(
      pipe(
        start(),
        Scope.provide(scope),
        Effect.mapError((cause) =>
          cause instanceof PtyUnavailable
            ? cause
            : new PtyUnavailable({
                message: messageFrom(cause, "Unable to prepare Herdr"),
              }),
        ),
      ),
    );

    const open: Interface["open"] = Effect.fn(
      "Shell.Herdr.Private.open",
    )(function* (command) {
      const current = yield* runtime;
      const commandId = randomBytes(config.descriptorTokenBytes).toString(
        "hex",
      );
      const pending = yield* register(commandId);
      const descriptorPath = path.join(current.root, `${commandId}.json`);
      const environment = Object.fromEntries(
        Object.entries({ ...process.env, ...command.env }).flatMap(
          ([name, value]) =>
            value === null || value === undefined ? [] : [[name, value]],
        ),
      );
      const abort = complete(pending, false);

      const descriptor = yield* pipe(
        encodeDescriptor({
          commandId,
          controlSocket: current.controlSocketPath,
          cmd: command.cmd,
          cwd: command.cwd,
          env: environment,
        }),
        Effect.mapError(
          (cause) =>
            new PtyUnavailable({
              message: messageFrom(
                cause,
                "Unable to encode the PTY command descriptor",
              ),
            }),
        ),
      );

      yield* pipe(
        fileSystem.writeFileString(descriptorPath, descriptor),
        Effect.andThen(fileSystem.chmod(descriptorPath, 0o600)),
        Effect.mapError(
          (cause) =>
            new PtyUnavailable({
              message: messageFrom(
                cause,
                "Unable to create the PTY command descriptor",
              ),
            }),
        ),
        Effect.onError(() => abort),
      );

      const pane = yield* pipe(
        repo.createWorkspace(current.socketPath, command.cwd, {
          STRATUM_DESCRIPTOR: descriptorPath,
        }),
        Effect.mapError(
          (failure) => new PtyUnavailable({ message: failure.message }),
        ),
        Effect.onError(() =>
          pipe(
            fileSystem.remove(descriptorPath, { force: true }),
            Effect.ignore,
            Effect.andThen(abort),
          ),
        ),
      );

      const started = yield* pipe(
        Deferred.await(pending.started),
        Effect.timeoutOrElse({
          duration: config.requestTimeoutMillis,
          orElse: () =>
            Effect.fail<StartupFailure>({
              message: "Timed out waiting for the PTY command to start",
            }),
        }),
        Effect.catch((failure) =>
          pipe(
            complete(pending, failure.release === true),
            Effect.andThen(Effect.fail(failure)),
          ),
        ),
        Effect.mapError(
          (failure) => new PtyUnavailable({ message: failure.message }),
        ),
      );

      return {
        socketPath: current.socketPath,
        pane,
        launch: {
          processGroup: started.processGroup,
          exit: Deferred.await(pending.exited),
          release: complete(pending, true),
        },
      };
    });

    return Service.of({ open });
  }),
);

export * as Private from "./private.ts";
