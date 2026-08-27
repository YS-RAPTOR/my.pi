import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Path,
  Semaphore,
  pipe,
} from "effect";
import { Config } from "#s/config";
import { Store } from "./store.ts";
import type { Running } from "./store.ts";
import { Tmux } from "./tmux.ts";

export class OpenInput extends Data.Class<{
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | null>>;
}> {}

export class OpenResult extends Data.Class<{
  readonly id: string;
}> {}

export class ReadInput extends Data.Class<{
  readonly id: string;
  readonly lines?: number | null;
  readonly offset?: number;
}> {}

export class Continuation extends Data.Class<{
  readonly offset: number;
  readonly remainingLines: number;
}> {}

export class ReadResult extends Data.Class<{
  readonly text: string;
  readonly continuation: Continuation | null;
}> {}

export class ListInput extends Data.Class<{
  readonly isRunning?: boolean;
}> {}

export class OperationFailed extends Data.TaggedError("ShellOperationFailed")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type ShellError =
  | OperationFailed
  | Store.ResourceNotFound
  | Store.OperationFailed
  | Tmux.OperationFailed;

export type Interface = Readonly<{
  open: (input: OpenInput) => Effect.Effect<OpenResult, ShellError>;
  read: (input: ReadInput) => Effect.Effect<ReadResult, ShellError>;
  write: (id: string, text: string) => Effect.Effect<void, ShellError>;
  sendKeys: (id: string, keys: ReadonlyArray<string>) => Effect.Effect<void, ShellError>;
  info: (id: string) => Effect.Effect<Store.Info, ShellError>;
  list: (input?: ListInput) => Effect.Effect<ReadonlyArray<string>, ShellError>;
  wait: (id: string, timeout?: number) => Effect.Effect<Store.Info, ShellError>;
  kill: (id: string) => Effect.Effect<void, ShellError>;
}>;

export class Service extends Context.Service<Service, Interface>()("stratum/Features.Shell") {}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { shell: config } = yield* Config.Service;
    const paths = yield* Path.Path;
    const store = yield* Store.Service;
    const tmux = yield* Tmux.Service;
    const mutex = yield* Semaphore.make(1);

    const finalize = Effect.fn("Shell.__finalize")(function* (resource: Running) {
      const current = yield* store.get(resource.metadata.id);
      if (Store.Resource.$is("completed")(current)) return current;

      const status = yield* tmux.status(resource.target);
      if (!status.dead) return;
      const [visible, history] = yield* Effect.all(
        [tmux.capture(resource.target, false), tmux.capture(resource.target, true)],
        { concurrency: "unbounded" },
      );
      const completed = yield* store.complete(
        resource,
        new Store.Info({
          ...resource.metadata,
          isRunning: false,
          exitCode: status.exitCode,
          signal: status.signal,
        }),
        visible,
        history,
      );
      yield* tmux.remove(resource.target);
      return completed;
    });

    const refresh = Effect.fn("Shell.__refresh")(function* (id: string) {
      const resource = yield* store.get(id);
      if (Store.Resource.$is("completed")(resource)) return resource;
      return (yield* finalize(resource)) ?? resource;
    });

    const open: Interface["open"] = Effect.fn("Shell.open")(function* (input) {
      return yield* Effect.uninterruptible(
        mutex.withPermit(
          Effect.gen(function* () {
            const id = globalThis.crypto.randomUUID();
            const cwd = paths.resolve(input.cwd ?? process.cwd());
            const target = yield* tmux.open(id, cwd, input.command, input.env);
            const resource = yield* store.register(
              new Store.Metadata({
                id,
                command: input.command,
                cwd,
                startedAt: yield* Clock.currentTimeMillis,
              }),
              target,
            );
            return new OpenResult({ id: resource.metadata.id });
          }),
        ),
      );
    });

    const read: Interface["read"] = Effect.fn("Shell.read")(function* (input) {
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const resource = yield* refresh(input.id);
          const lines =
            input.lines === undefined || input.lines === null
              ? null
              : Math.min(input.lines, config["max-read-lines"]);
          const offset = input.offset ?? 0;
          if (lines === null) {
            const output = Store.Resource.$is("running")(resource)
              ? yield* tmux.capture(resource.target, false)
              : (yield* store.artifact(resource)).visible;
            return new ReadResult({ text: output, continuation: null });
          }

          const history = Store.Resource.$is("running")(resource)
            ? yield* tmux.capture(resource.target, true)
            : (yield* store.artifact(resource)).history;
          const available = history === "" ? [] : history.split("\n");
          const end = Math.max(0, available.length - offset);
          const start = Math.max(0, end - lines);
          const output = available.slice(start, end).join("\n");
          if (start === 0) return new ReadResult({ text: output, continuation: null });
          return new ReadResult({
            text: output,
            continuation: new Continuation({
              offset: offset + (end - start),
              remainingLines: start,
            }),
          });
        }),
      );
    });

    const running = Effect.fn("Shell.__running")(function* (id: string) {
      const resource = yield* refresh(id);
      if (Store.Resource.$is("running")(resource)) return resource;
      return yield* new OperationFailed({
        operation: "access running shell resource",
        message: `Shell resource ${id} is no longer running`,
      });
    });

    const write: Interface["write"] = Effect.fn("Shell.write")(function* (id, text) {
      yield* mutex.withPermit(
        Effect.gen(function* () {
          const resource = yield* running(id);
          yield* tmux.write(resource.target, text);
        }),
      );
    });

    const sendKeys: Interface["sendKeys"] = Effect.fn("Shell.sendKeys")(
      function* (id, keys) {
        yield* mutex.withPermit(
          Effect.gen(function* () {
            const resource = yield* running(id);
            yield* tmux.sendKeys(resource.target, keys);
          }),
        );
      },
    );

    const info: Interface["info"] = Effect.fn("Shell.info")(function* (id) {
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const resource = yield* refresh(id);
          if (Store.Resource.$is("completed")(resource)) {
            return (yield* store.artifact(resource)).info;
          }
          return new Store.Info({
            ...resource.metadata,
            isRunning: true,
            exitCode: null,
            signal: null,
          });
        }),
      );
    });

    const list: Interface["list"] = Effect.fn("Shell.list")(function* (input) {
      const resources = yield* store.entries;
      const information = yield* Effect.forEach(resources, (resource) => info(resource.metadata.id));
      return information
        .filter((item) => input?.isRunning === undefined || item.isRunning === input.isRunning)
        .sort((left, right) =>
          right.startedAt === left.startedAt
            ? right.id.localeCompare(left.id)
            : right.startedAt - left.startedAt,
        )
        .map((item) => item.id);
    });

    const wait: Interface["wait"] = Effect.fn("Shell.wait")(function* (
      id,
      timeout = config["default-wait-timeout-seconds"],
    ) {
      const resource = yield* mutex.withPermit(refresh(id));
      if (Store.Resource.$is("completed")(resource)) {
        return (yield* store.artifact(resource)).info;
      }
      return yield* Effect.raceFirst(
        pipe(tmux.wait(resource.target), Effect.andThen(info(id))),
        pipe(Effect.sleep(Duration.seconds(timeout)), Effect.andThen(info(id))),
      );
    });

    const kill: Interface["kill"] = Effect.fn("Shell.kill")(function* (id) {
      const target = yield* mutex.withPermit(
        Effect.gen(function* () {
          const resource = yield* refresh(id);
          if (Store.Resource.$is("completed")(resource)) {
            return Option.none<Running>();
          }
          yield* tmux.kill(resource.target);
          return Option.some(resource);
        }),
      );
      if (Option.isNone(target)) return;
      yield* tmux.wait(target.value.target);
      yield* mutex.withPermit(refresh(id));
    });

    yield* Effect.addFinalizer(
      Effect.fn("Shell.shutdown")(function* () {
        const resources = yield* store.entries;
        yield* Effect.forEach(
          resources,
          (resource) =>
            Store.Resource.$is("running")(resource)
              ? pipe(kill(resource.metadata.id), Effect.ignore)
              : Effect.void,
          { discard: true, concurrency: "unbounded" },
        );
      }),
    );

    return Service.of({
      open,
      read,
      write,
      sendKeys,
      info,
      list,
      wait,
      kill,
    });
  }),
);
