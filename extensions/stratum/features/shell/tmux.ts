import { constants as osConstants } from "node:os";
import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Semaphore,
  Stream,
  pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const terminalWidth = 175;
const terminalHeight = 75;
const historyLimit = 100_000;

export class Target extends Data.Class<{
  readonly sessionId: string;
  readonly paneId: string;
}> {}

export class Status extends Data.Class<{
  readonly dead: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
}> {}

export class OperationFailed extends Data.TaggedError(
  "ShellTmuxOperationFailed",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export type Interface = Readonly<{
  open: (
    resourceId: string,
    cwd: string,
    command: string,
    env?: Readonly<Record<string, string | null>>,
  ) => Effect.Effect<Target, OperationFailed>;
  capture: (
    target: Target,
    history: boolean,
  ) => Effect.Effect<string, OperationFailed>;
  status: (target: Target) => Effect.Effect<Status, OperationFailed>;
  write: (target: Target, text: string) => Effect.Effect<void, OperationFailed>;
  sendKeys: (
    target: Target,
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<void, OperationFailed>;
  wait: (target: Target) => Effect.Effect<void, OperationFailed>;
  kill: (target: Target) => Effect.Effect<void, OperationFailed>;
  remove: (target: Target) => Effect.Effect<void>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Shell.Tmux",
) {}

type Backend = Readonly<{
  socketName: string;
}>;

type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

const messageFrom = (cause: unknown): string =>
  cause instanceof globalThis.Error ? cause.message : String(cause);

const signalName = (value: string): string | null => {
  if (value === "" || value === "0") return null;
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return value.startsWith("SIG") ? value : `SIG${value}`;
  }
  for (const [name, candidate] of Object.entries(osConstants.signals)) {
    if (candidate === number) return name;
  }
  return `SIG${value}`;
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const initialization = yield* Semaphore.make(1);
    const backend = yield* Ref.make<Option.Option<Backend>>(Option.none());

    const execute = Effect.fn("Shell.Tmux.__execute")(function* (
      operation: string,
      command: string,
      arguments_: ReadonlyArray<string>,
    ) {
      return yield* pipe(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, arguments_, {
                extendEnv: true,
                stdin: "ignore",
              }),
            );
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            if (Number(exitCode) !== 0) {
              return yield* new OperationFailed({
                operation,
                message:
                  stderr.trim() ||
                  stdout.trim() ||
                  `${command} exited with code ${Number(exitCode)}`,
              });
            }
            return { stdout, stderr } satisfies CommandResult;
          }),
        ),
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, "ShellTmuxOperationFailed")
            ? cause
            : new OperationFailed({
                operation,
                message: messageFrom(cause),
              }),
        ),
      );
    });

    const invoke = Effect.fn("Shell.Tmux.__invoke")(function* (
      current: Backend,
      operation: string,
      ...arguments_: ReadonlyArray<string>
    ) {
      return yield* execute(operation, "tmux", [
        "-L",
        current.socketName,
        ...arguments_,
      ]);
    });

    const ensure = Effect.fn("Shell.Tmux.__ensure")(function* () {
      return yield* initialization.withPermit(
        Effect.gen(function* () {
          const existing = yield* Ref.get(backend);
          if (Option.isSome(existing)) return existing.value;

          const current: Backend = {
            socketName: `stratum-${globalThis.crypto.randomUUID()}`,
          };
          yield* invoke(
            current,
            "initialize tmux",
            "start-server",
            ";",
            "set-option",
            "-s",
            "exit-empty",
            "off",
            ";",
            "set-option",
            "-g",
            "history-limit",
            String(historyLimit),
            ";",
            "set-option",
            "-gw",
            "remain-on-exit",
            "on",
            ";",
            "set-option",
            "-gw",
            "remain-on-exit-format",
            "",
            ";",
            "set-hook",
            "-g",
            "pane-died",
            `run-shell -b "tmux -L ${current.socketName} wait-for -S shell-exit-#{pane_id}"`,
          );
          yield* Ref.set(backend, Option.some(current));
          return current;
        }),
      );
    });

    const open: Interface["open"] = Effect.fn("Shell.Tmux.open")(
      function* (resourceId, cwd, command, env) {
        const current = yield* ensure();
        const sessionId = `shell-${resourceId}`;
        const arguments_: Array<string> = [
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-s",
          sessionId,
          "-c",
          cwd,
          "-x",
          String(terminalWidth),
          "-y",
          String(terminalHeight),
        ];
        const removed: Array<string> = [];
        for (const [name, value] of Object.entries(env ?? {})) {
          if (value === null) removed.push(name);
          else arguments_.push("-e", `${name}=${value}`);
        }
        if (removed.length > 0) {
          arguments_.push("env");
          for (const name of removed) arguments_.push("-u", name);
        }
        arguments_.push("bash", "-lc", command);

        const paneId = (yield* invoke(
          current,
          "open shell resource",
          ...arguments_,
        )).stdout.trim();
        if (paneId.startsWith("%")) return new Target({ sessionId, paneId });

        yield* pipe(
          invoke(
            current,
            "clean up invalid shell resource",
            "kill-session",
            "-t",
            sessionId,
          ),
          Effect.ignore,
        );
        return yield* new OperationFailed({
          operation: "open shell resource",
          message: `tmux returned an invalid pane ID: ${JSON.stringify(paneId)}`,
        });
      },
    );

    const capture: Interface["capture"] = Effect.fn("Shell.Tmux.capture")(
      function* (target, history) {
        const current = yield* ensure();
        const arguments_ = history
          ? ["capture-pane", "-p", "-S", "-", "-E", "-", "-t", target.paneId]
          : ["capture-pane", "-p", "-t", target.paneId];
        return (yield* invoke(
          current,
          "capture tmux pane",
          ...arguments_,
        )).stdout.trimEnd();
      },
    );

    const status: Interface["status"] = Effect.fn("Shell.Tmux.status")(
      function* (target) {
        const current = yield* ensure();
        const result = yield* invoke(
          current,
          "inspect tmux pane",
          "display-message",
          "-p",
          "-t",
          target.paneId,
          "#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}",
        );
        const [dead = "0", exitCode = "", signal = ""] = result.stdout
          .trim()
          .split("\t");
        return new Status({
          dead: dead === "1",
          exitCode:
            exitCode === "" || !Number.isInteger(Number(exitCode))
              ? null
              : Number(exitCode),
          signal: signalName(signal),
        });
      },
    );

    const write: Interface["write"] = Effect.fn("Shell.Tmux.write")(
      function* (target, text) {
        const current = yield* ensure();
        yield* invoke(
          current,
          "write literal shell input",
          "send-keys",
          "-l",
          "-t",
          target.paneId,
          "--",
          text,
        );
      },
    );

    const sendKeys: Interface["sendKeys"] = Effect.fn("Shell.Tmux.sendKeys")(
      function* (target, keys) {
        const current = yield* ensure();
        yield* invoke(
          current,
          "send shell keys",
          "send-keys",
          "-t",
          target.paneId,
          "--",
          ...keys,
        );
      },
    );

    const wait: Interface["wait"] = Effect.fn("Shell.Tmux.wait")(
      function* (target) {
        const current = yield* ensure();
        yield* invoke(
          current,
          "wait for shell resource",
          "if-shell",
          "-F",
          "-t",
          target.paneId,
          "#{pane_dead}",
          "display-message",
          `wait-for shell-exit-${target.paneId}`,
        );
      },
    );

    const kill: Interface["kill"] = Effect.fn("Shell.Tmux.kill")(
      function* (target) {
        const current = yield* ensure();
        const pid = (yield* invoke(
          current,
          "inspect shell process group",
          "display-message",
          "-p",
          "-t",
          target.paneId,
          "#{pane_pid}",
        )).stdout.trim();
        yield* execute("kill shell resource", "kill", [
          "-KILL",
          "--",
          `-${pid}`,
        ]);
      },
    );

    const remove: Interface["remove"] = Effect.fn("Shell.Tmux.remove")(
      function* (target) {
        const current = yield* Ref.get(backend);
        if (Option.isNone(current)) return;
        yield* pipe(
          invoke(
            current.value,
            "remove completed tmux session",
            "kill-session",
            "-t",
            target.sessionId,
          ),
          Effect.ignore,
        );
      },
    );

    yield* Effect.addFinalizer(
      Effect.fn("Shell.Tmux.shutdown")(function* () {
        const current = yield* Ref.get(backend);
        if (Option.isNone(current)) return;
        yield* pipe(
          invoke(current.value, "stop private tmux server", "kill-server"),
          Effect.ignore,
        );
      }),
    );

    return Service.of({
      open,
      capture,
      status,
      write,
      sendKeys,
      wait,
      kill,
      remove,
    });
  }),
);

export * as Tmux from "./tmux.ts";
