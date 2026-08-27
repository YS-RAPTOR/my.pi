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
  readonly cmd: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | null>>;
}> {}

export class OpenResult extends Data.Class<{
  readonly resourceId: string;
}> {}

export class ReadInput extends Data.Class<{
  readonly resourceId: string;
  readonly lines?: number | null;
  readonly offset?: number;
}> {}

export class Continuation extends Data.Class<{
  readonly offset: number;
  readonly remainingLines: number;
}> {}

export class ReadResult extends Data.Class<{
  readonly output: string;
  readonly continuation?: Continuation;
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
  write: (resourceId: string, text: string) => Effect.Effect<void, ShellError>;
  sendKeys: (resourceId: string, keys: ReadonlyArray<string>) => Effect.Effect<void, ShellError>;
  inspect: (resourceId: string) => Effect.Effect<Store.Inspection, ShellError>;
  list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Store.Inspection>, ShellError>;
  wait: (resourceId: string, timeout?: number) => Effect.Effect<Store.Inspection, ShellError>;
  kill: (resourceId: string) => Effect.Effect<void, ShellError>;
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
      const current = yield* store.get(resource.metadata.resourceId);
      if (Store.Resource.$is("completed")(current)) return current;

      const status = yield* tmux.status(resource.target);
      if (!status.dead) return;
      const [visible, history] = yield* Effect.all(
        [tmux.capture(resource.target, false), tmux.capture(resource.target, true)],
        { concurrency: "unbounded" },
      );
      const completed = yield* store.complete(
        resource,
        new Store.Inspection({
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

    const refresh = Effect.fn("Shell.__refresh")(function* (resourceId: string) {
      const resource = yield* store.get(resourceId);
      if (Store.Resource.$is("completed")(resource)) return resource;
      return (yield* finalize(resource)) ?? resource;
    });

    const open: Interface["open"] = Effect.fn("Shell.open")(function* (input) {
      return yield* Effect.uninterruptible(
        mutex.withPermit(
          Effect.gen(function* () {
            const resourceId = globalThis.crypto.randomUUID();
            const cwd = paths.resolve(input.cwd ?? process.cwd());
            const target = yield* tmux.open(resourceId, cwd, input.cmd, input.env);
            const resource = yield* store.register(
              new Store.Metadata({
                resourceId,
                command: input.cmd,
                cwd,
                startedAt: yield* Clock.currentTimeMillis,
              }),
              target,
            );
            return new OpenResult({ resourceId: resource.metadata.resourceId });
          }),
        ),
      );
    });

    const read: Interface["read"] = Effect.fn("Shell.read")(function* (input) {
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const resource = yield* refresh(input.resourceId);
          const lines =
            input.lines === undefined || input.lines === null
              ? null
              : Math.min(input.lines, config["max-read-lines"]);
          const offset = input.offset ?? 0;
          if (lines === null) {
            const output = Store.Resource.$is("running")(resource)
              ? yield* tmux.capture(resource.target, false)
              : (yield* store.artifact(resource)).visible;
            return new ReadResult({ output });
          }

          const history = Store.Resource.$is("running")(resource)
            ? yield* tmux.capture(resource.target, true)
            : (yield* store.artifact(resource)).history;
          const available = history === "" ? [] : history.split("\n");
          const end = Math.max(0, available.length - offset);
          const start = Math.max(0, end - lines);
          const output = available.slice(start, end).join("\n");
          if (start === 0) return new ReadResult({ output });
          return new ReadResult({
            output,
            continuation: new Continuation({
              offset: offset + (end - start),
              remainingLines: start,
            }),
          });
        }),
      );
    });

    const running = Effect.fn("Shell.__running")(function* (resourceId: string) {
      const resource = yield* refresh(resourceId);
      if (Store.Resource.$is("running")(resource)) return resource;
      return yield* new OperationFailed({
        operation: "access running shell resource",
        message: `Shell resource ${resourceId} is no longer running`,
      });
    });

    const write: Interface["write"] = Effect.fn("Shell.write")(function* (resourceId, text) {
      yield* mutex.withPermit(
        Effect.gen(function* () {
          const resource = yield* running(resourceId);
          yield* tmux.write(resource.target, text);
        }),
      );
    });

    const sendKeys: Interface["sendKeys"] = Effect.fn("Shell.sendKeys")(
      function* (resourceId, keys) {
        yield* mutex.withPermit(
          Effect.gen(function* () {
            const resource = yield* running(resourceId);
            yield* tmux.sendKeys(resource.target, keys);
          }),
        );
      },
    );

    const inspect: Interface["inspect"] = Effect.fn("Shell.inspect")(function* (resourceId) {
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const resource = yield* refresh(resourceId);
          if (Store.Resource.$is("completed")(resource)) {
            return (yield* store.artifact(resource)).inspection;
          }
          return new Store.Inspection({
            ...resource.metadata,
            isRunning: true,
          });
        }),
      );
    });

    const list: Interface["list"] = Effect.fn("Shell.list")(function* (input) {
      const resources = yield* store.entries;
      const inspected = yield* Effect.forEach(resources, (resource) =>
        inspect(resource.metadata.resourceId),
      );
      return inspected
        .filter(
          (resource) => input?.isRunning === undefined || resource.isRunning === input.isRunning,
        )
        .sort((left, right) =>
          right.startedAt === left.startedAt
            ? right.resourceId.localeCompare(left.resourceId)
            : right.startedAt - left.startedAt,
        );
    });

    const wait: Interface["wait"] = Effect.fn("Shell.wait")(function* (
      resourceId,
      timeout = config["default-wait-timeout-seconds"],
    ) {
      const resource = yield* mutex.withPermit(refresh(resourceId));
      if (Store.Resource.$is("completed")(resource)) {
        return (yield* store.artifact(resource)).inspection;
      }
      return yield* Effect.raceFirst(
        pipe(tmux.wait(resource.target), Effect.andThen(inspect(resourceId))),
        pipe(Effect.sleep(Duration.seconds(timeout)), Effect.andThen(inspect(resourceId))),
      );
    });

    const kill: Interface["kill"] = Effect.fn("Shell.kill")(function* (resourceId) {
      const target = yield* mutex.withPermit(
        Effect.gen(function* () {
          const resource = yield* refresh(resourceId);
          if (Store.Resource.$is("completed")(resource)) {
            return Option.none<Running>();
          }
          yield* tmux.kill(resource.target);
          return Option.some(resource);
        }),
      );
      if (Option.isNone(target)) return;
      yield* tmux.wait(target.value.target);
      yield* mutex.withPermit(refresh(resourceId));
    });

    yield* Effect.addFinalizer(
      Effect.fn("Shell.shutdown")(function* () {
        const resources = yield* store.entries;
        yield* Effect.forEach(
          resources,
          (resource) =>
            Store.Resource.$is("running")(resource)
              ? pipe(kill(resource.metadata.resourceId), Effect.ignore)
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
      inspect,
      list,
      wait,
      kill,
    });
  }),
);
