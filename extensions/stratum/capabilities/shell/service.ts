import type {
  CloseStdin,
  Inspect,
  List,
  Open,
  OpenFailed,
  PtyUnavailable,
  ResourceId,
  ResourceSummary,
  Signal,
  SignalFailed,
  Snapshot,
  SnapshotFailed,
  StdinClosed,
  TerminalSnapshot,
  Write,
} from "./types.ts";
import {
  Array,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Order,
  pipe,
  Predicate,
  Scope,
} from "effect";
import { Session } from "#s/common/session";
import { Herdr } from "./herdr/index.ts";
import { Stdio } from "./stdio/index.ts";
import { Store } from "./store.ts";
import {
  CloseStdinUnavailable,
  ListSuccess,
  OpenSuccess,
  ResourceNotFound,
  SnapshotUnavailable,
} from "./types.ts";

const textEncoder = new TextEncoder();
const summariesByInteraction = Order.make<ResourceSummary>((self, that) => {
  const interaction = Order.flip(Order.Number)(
    self.last_interaction,
    that.last_interaction,
  );
  return interaction !== 0
    ? interaction
    : Order.String(self.resource_id.value, that.resource_id.value);
});

export type Interface = Readonly<{
  open: (
    session: Session.ID,
    request: Open,
  ) => Effect.Effect<OpenSuccess, OpenFailed | PtyUnavailable>;
  snapshot: (
    session: Session.ID,
    request: Snapshot,
  ) => Effect.Effect<
    TerminalSnapshot,
    ResourceNotFound | SnapshotUnavailable | SnapshotFailed
  >;
  wait: (
    session: Session.ID,
    resourceId: ResourceId,
    yieldAfter: number,
  ) => Effect.Effect<boolean, ResourceNotFound>;
  list: (session: Session.ID, request: List) => Effect.Effect<ListSuccess>;
  inspect: (
    session: Session.ID,
    request: Inspect,
  ) => Effect.Effect<ResourceSummary, ResourceNotFound>;
  write: (
    session: Session.ID,
    request: Write,
  ) => Effect.Effect<void, ResourceNotFound | StdinClosed>;
  closeStdin: (
    session: Session.ID,
    request: CloseStdin,
  ) => Effect.Effect<void, ResourceNotFound | CloseStdinUnavailable>;
  signal: (
    session: Session.ID,
    request: Signal,
  ) => Effect.Effect<void, ResourceNotFound | SignalFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Shell",
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
        return yield* new ResourceNotFound({ resource_id: resourceId });
      }
      return found.value;
    });

    const open: Interface["open"] = Effect.fn("Shell.open")(
      function* (session, request) {
        if (request.pty === true) {
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const resource = yield* herdr.open(session, request);
              const registered = yield* store.register({
                _tag: "terminal",
                resource,
              });
              yield* pipe(
                resource.supervise(registered.id),
                Effect.forkIn(scope, { startImmediately: true }),
              );
              return new OpenSuccess({ resource_id: registered.id });
            }),
          );
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const resource = yield* restore(stdio.open(session, request));
            const registered = yield* store.register({
              _tag: "stdio",
              resource,
            });
            return new OpenSuccess({
              resource_id: registered.id,
              output_file: resource.outputFile,
            });
          }),
        );
      },
    );

    const snapshot: Interface["snapshot"] = Effect.fn("Shell.snapshot")(
      function* (session, request) {
        const found = yield* entry(request.resource_id);
        if (Predicate.isTagged(found, "stdio")) {
          return yield* new SnapshotUnavailable({
            resource_id: request.resource_id,
          });
        }
        return yield* found.resource.snapshot(found.id, session, request.lines);
      },
    );

    const wait: Interface["wait"] = Effect.fn("Shell.wait")(
      function* (session, resourceId, yieldAfter) {
        const found = yield* entry(resourceId);
        return yield* found.resource.wait(resourceId, session, yieldAfter);
      },
    );

    const discover = Effect.fn("Shell.__discover")(function* (
      session: Session.ID,
    ) {
      for (const candidate of yield* herdr.discover(session)) {
        const registered = yield* store.register({
          _tag: "terminal",
          resource: candidate.resource,
          identity: candidate.identity,
        });
        yield* pipe(
          Match.value(registered),
          Match.tagsExhaustive({
            stdio: () => Effect.void,
            terminal: (terminal) => terminal.resource.grant(session, false),
          }),
        );
      }
    });

    const summary = Effect.fn("Shell.__summary")(
      (found: Store.Entry, session: Session.ID) =>
        found.resource.inspect(found.id, session),
    );

    const list: Interface["list"] = Effect.fn("Shell.list")(
      function* (session, request) {
        yield* discover(session);
        const summaries = yield* Effect.forEach(
          yield* store.entries,
          (found) => summary(found, session),
          { concurrency: "unbounded" },
        );
        return new ListSuccess({
          resources: pipe(
            summaries,
            Array.getSomes,
            Array.filter(
              (resource) =>
                request.active === undefined ||
                request.active ===
                  (Predicate.isTagged(resource.lifecycle, "running") ||
                    Predicate.isTagged(resource.lifecycle, "draining")),
            ),
            Array.sort(summariesByInteraction),
          ),
        });
      },
    );

    const inspect: Interface["inspect"] = Effect.fn("Shell.inspect")(
      function* (session, request) {
        const value = yield* summary(
          yield* entry(request.resource_id),
          session,
        );
        if (Option.isNone(value)) {
          return yield* new ResourceNotFound({
            resource_id: request.resource_id,
          });
        }
        return value.value;
      },
    );

    const write: Interface["write"] = Effect.fn("Shell.write")(
      function* (session, request) {
        const found = yield* entry(request.resource_id);
        if (Predicate.isTagged(found, "stdio")) {
          return yield* found.resource.write(
            request.resource_id,
            session,
            textEncoder.encode(request.text),
          );
        }
        return yield* found.resource.write(found.id, session, request.text);
      },
    );

    const closeStdin: Interface["closeStdin"] = Effect.fn("Shell.closeStdin")(
      function* (session, request) {
        const found = yield* entry(request.resource_id);
        if (Predicate.isTagged(found, "stdio")) {
          return yield* found.resource.closeStdin(session);
        }
        yield* found.resource.grant(session, true);
        return yield* new CloseStdinUnavailable({
          resource_id: request.resource_id,
        });
      },
    );

    const signal: Interface["signal"] = Effect.fn("Shell.signal")(
      function* (session, request) {
        const found = yield* entry(request.resource_id);
        return yield* found.resource.signal(
          request.resource_id,
          session,
          request.signal,
        );
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
