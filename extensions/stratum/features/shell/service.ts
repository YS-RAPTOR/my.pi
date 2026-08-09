import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Option,
  Order,
  pipe,
  Predicate,
  Scope,
} from "effect";
import { Herdr } from "./herdr/index.ts";
import { Stdio } from "./stdio/index.ts";
import { Store } from "./store.ts";
import type {
  Open,
  OpenFailed,
  PtyUnavailable,
  ResourceId,
  ResourceSummary,
  SignalFailed,
  SnapshotFailed,
  StdinClosed,
  TerminalSnapshot,
} from "./types.ts";
import {
  CloseStdinUnavailable,
  Opened,
  ResourceNotFound,
  SnapshotUnavailable,
} from "./types.ts";

const textEncoder = new TextEncoder();
const summariesByStart = Order.make<ResourceSummary>((self, that) => {
  const started = Order.flip(Order.Number)(self.startedAt, that.startedAt);
  return started !== 0
    ? started
    : Order.String(self.resourceId.value, that.resourceId.value);
});

export type Interface = Readonly<{
  open: (
    request: Open,
  ) => Effect.Effect<Opened, OpenFailed | PtyUnavailable>;
  snapshot: (
    resourceId: ResourceId,
    lines: number | null,
  ) => Effect.Effect<
    TerminalSnapshot,
    ResourceNotFound | SnapshotUnavailable | SnapshotFailed
  >;
  wait: (
    resourceId: ResourceId,
    yieldAfter: number,
  ) => Effect.Effect<boolean, ResourceNotFound>;
  list: (
    active?: boolean,
  ) => Effect.Effect<ReadonlyArray<ResourceSummary>>;
  inspect: (
    resourceId: ResourceId,
  ) => Effect.Effect<ResourceSummary, ResourceNotFound>;
  write: (
    resourceId: ResourceId,
    text: string,
  ) => Effect.Effect<void, ResourceNotFound | StdinClosed>;
  closeStdin: (
    resourceId: ResourceId,
  ) => Effect.Effect<void, ResourceNotFound | CloseStdinUnavailable>;
  signal: (
    resourceId: ResourceId,
    signal: string,
  ) => Effect.Effect<void, ResourceNotFound | SignalFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Shell",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const herdr = yield* Herdr.Service;
    const stdio = yield* Stdio.Service;
    const scope = yield* Scope.Scope;
    const store = yield* Store.Service;

    const entry = Effect.fn("Shell.__entry")(function* (
      resourceId: ResourceId,
    ) {
      const found = yield* store.get(resourceId);
      if (Option.isNone(found)) {
        return yield* new ResourceNotFound({ resourceId });
      }
      return found.value;
    });

    const open: Interface["open"] = Effect.fn("Shell.open")(
      function* (request) {
        if (request.pty === true) {
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const resource = yield* herdr.open(request);
              const registered = yield* store.register(
                Store.NewEntry.terminal({ resource }),
              );
              yield* pipe(
                resource.supervise(registered.id),
                Effect.forkIn(scope, { startImmediately: true }),
              );
              return new Opened({ resourceId: registered.id });
            }),
          );
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const resource = yield* restore(stdio.open(request));
            const registered = yield* store.register(
              Store.NewEntry.stdio({ resource }),
            );
            return new Opened({
              resourceId: registered.id,
              outputFile: resource.outputFile,
            });
          }),
        );
      },
    );

    const snapshot: Interface["snapshot"] = Effect.fn(
      "Shell.snapshot",
    )(function* (resourceId, lines) {
      const found = yield* entry(resourceId);
      if (Predicate.isTagged(found, "stdio")) {
        return yield* new SnapshotUnavailable({ resourceId });
      }
      return yield* found.resource.snapshot(found.id, lines);
    });

    const wait: Interface["wait"] = Effect.fn("Shell.wait")(
      function* (resourceId, yieldAfter) {
        const found = yield* entry(resourceId);
        return Predicate.isTagged(found, "stdio")
          ? yield* found.resource.wait(yieldAfter)
          : yield* found.resource.wait(found.id, yieldAfter);
      },
    );

    const discover = Effect.fn("Shell.__discover")(function* () {
      for (const candidate of yield* herdr.discover) {
        yield* store.register(
          Store.NewEntry.terminal({
            resource: candidate.resource,
            identity: candidate.identity,
          }),
        );
      }
    });

    const summary = Effect.fn("Shell.__summary")(
      (found: Store.Entry) => found.resource.inspect(found.id),
    );

    const list: Interface["list"] = Effect.fn("Shell.list")(
      function* (active) {
        yield* discover();
        const summaries = yield* Effect.forEach(
          yield* store.entries,
          summary,
          { concurrency: "unbounded" },
        );
        return pipe(
          summaries,
          Arr.getSomes,
          Arr.filter(
            (resource) =>
              active === undefined ||
              active ===
                (Predicate.isTagged(resource.lifecycle, "running") ||
                  Predicate.isTagged(resource.lifecycle, "draining")),
          ),
          Arr.sort(summariesByStart),
        );
      },
    );

    const inspect: Interface["inspect"] = Effect.fn(
      "Shell.inspect",
    )(function* (resourceId) {
      const value = yield* summary(yield* entry(resourceId));
      if (Option.isNone(value)) {
        return yield* new ResourceNotFound({ resourceId });
      }
      return value.value;
    });

    const write: Interface["write"] = Effect.fn("Shell.write")(
      function* (resourceId, text) {
        const found = yield* entry(resourceId);
        if (Predicate.isTagged(found, "stdio")) {
          return yield* found.resource.write(
            resourceId,
            textEncoder.encode(text),
          );
        }
        return yield* found.resource.write(found.id, text);
      },
    );

    const closeStdin: Interface["closeStdin"] = Effect.fn(
      "Shell.closeStdin",
    )(function* (resourceId) {
      const found = yield* entry(resourceId);
      if (Predicate.isTagged(found, "stdio")) {
        return yield* found.resource.closeStdin;
      }
      return yield* new CloseStdinUnavailable({ resourceId });
    });

    const signal: Interface["signal"] = Effect.fn("Shell.signal")(
      function* (resourceId, signal) {
        const found = yield* entry(resourceId);
        return yield* found.resource.signal(resourceId, signal);
      },
    );

    return Service.of({
      open,
      snapshot,
      wait,
      list,
      inspect,
      write,
      closeStdin,
      signal,
    });
  }),
);
