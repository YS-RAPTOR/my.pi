import {
  Clock,
  Context,
  Duration,
  Effect,
  FiberMap,
  HashMap,
  Layer,
  Option,
  PubSub,
  Semaphore,
  Stream,
  SubscriptionRef,
  pipe,
} from "effect";
import { Activity } from "#s/capabilities/activity";
import { Owner } from "#s/common/owner";
import {
  Changed,
  Entry,
  Get,
  Start,
  Status,
  Stop,
  Triggered,
} from "./types.ts";

type OwnerValue = typeof Owner.Type;
type State = HashMap.HashMap<OwnerValue, Entry>;
type Event = Changed | Triggered;
type Trigger = Readonly<{ owner: OwnerValue; event: Triggered }>;
type Step = Readonly<{
  entry: Entry;
  running: boolean;
  triggered: boolean;
}>;

export type Interface = Readonly<{
  start: (request: Start) => Effect.Effect<Entry>;
  get: (request: Get) => Effect.Effect<Entry | null>;
  stop: (request: Stop) => Effect.Effect<void>;
  watch: (owner: OwnerValue) => Stream.Stream<Event>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Heartbeat",
) {}

const activityID = Activity.ID.make("heartbeat");
const active = Status.make("ACTIVE");
const paused = Status.make("PAUSED");

const nextRunAt = (now: number, request: Start) => {
  const next = now + request.interval_seconds * 1_000;
  return request.expires_at === null || next < request.expires_at ? next : null;
};

const nextWakeAt = (entry: Entry) => {
  if (entry.next_run_at === null) return entry.expires_at;
  if (entry.expires_at === null) return entry.next_run_at;
  return Math.min(entry.next_run_at, entry.expires_at);
};

const stepAt = (entry: Entry, now: number): Step => {
  if (entry.expires_at !== null && entry.expires_at <= now) {
    return {
      entry: new Entry({
        ...entry,
        status: paused,
        next_run_at: null,
        updated_at: now,
      }),
      running: false,
      triggered: false,
    };
  }

  if (entry.next_run_at === null || entry.next_run_at > now) {
    return { entry, running: true, triggered: false };
  }

  const candidate = now + entry.interval_seconds * 1_000;
  return {
    entry: new Entry({
      ...entry,
      next_run_at:
        entry.expires_at === null || candidate < entry.expires_at
          ? candidate
          : null,
      last_run_at: now,
      updated_at: now,
    }),
    running: true,
    triggered: true,
  };
};

const getEntry = (state: State, owner: OwnerValue) =>
  Option.getOrUndefined(HashMap.get(state, owner));

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const activity = yield* Activity.Service;
    const state = yield* SubscriptionRef.make<State>(HashMap.empty());
    const triggers = yield* PubSub.unbounded<Trigger>();
    const runners = yield* FiberMap.make<OwnerValue>();
    const mutex = yield* Semaphore.make(1);

    const step = (entry: Entry) =>
      mutex.withPermit(
        pipe(
          Clock.currentTimeMillis,
          Effect.map((now) => stepAt(entry, now)),
          Effect.tap((next) =>
            next.entry === entry
              ? Effect.void
              : SubscriptionRef.update(
                  state,
                  HashMap.set(entry.owner, next.entry),
                ),
          ),
          Effect.tap((next) =>
            next.triggered
              ? PubSub.publish(triggers, {
                  owner: entry.owner,
                  event: new Triggered({ instruction: entry.instruction }),
                })
              : Effect.void,
          ),
        ),
      );

    const run = (initial: Entry) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            activity.activate(
              new Activity.Activate({
                owner: initial.owner,
                id: activityID,
                reason: "Heartbeat active",
              }),
            ),
            () =>
              activity.release(
                new Activity.Release({
                  owner: initial.owner,
                  id: activityID,
                }),
              ),
          );

          yield* Stream.unfold(initial, (entry) => {
            const wakeAt = nextWakeAt(entry);
            if (wakeAt === null) return Effect.never;

            return pipe(
              Clock.currentTimeMillis,
              Effect.flatMap((beforeSleep) =>
                Effect.sleep(
                  Duration.millis(Math.max(0, wakeAt - beforeSleep)),
                ),
              ),
              Effect.andThen(step(entry)),
              Effect.map((next) =>
                next.running ? ([undefined, next.entry] as const) : undefined,
              ),
            );
          }).pipe(Stream.runDrain);
        }),
      );

    const start: Interface["start"] = Effect.fn("Heartbeat.start")(
      function* (request) {
        return yield* mutex.withPermit(
          Effect.gen(function* () {
            yield* FiberMap.remove(runners, request.owner);

            const now = yield* Clock.currentTimeMillis;
            const entry = new Entry({
              ...request,
              status: active,
              next_run_at: nextRunAt(now, request),
              last_run_at: null,
              created_at: now,
              updated_at: now,
            });
            yield* SubscriptionRef.update(
              state,
              HashMap.set(request.owner, entry),
            );
            yield* FiberMap.run(runners, request.owner, run(entry));
            return entry;
          }),
        );
      },
    );

    const get: Interface["get"] = Effect.fn("Heartbeat.get")(
      function* (request) {
        return Option.getOrNull(
          HashMap.get(yield* SubscriptionRef.get(state), request.owner),
        );
      },
    );

    const stop: Interface["stop"] = Effect.fn("Heartbeat.stop")(
      function* (request) {
        yield* mutex.withPermit(
          Effect.gen(function* () {
            const entry = getEntry(
              yield* SubscriptionRef.get(state),
              request.owner,
            );
            if (entry === undefined) return;

            if (entry.status === active) {
              const now = yield* Clock.currentTimeMillis;
              yield* SubscriptionRef.update(
                state,
                HashMap.set(
                  request.owner,
                  new Entry({
                    ...entry,
                    status: paused,
                    next_run_at: null,
                    updated_at: now,
                  }),
                ),
              );
            }
            yield* FiberMap.remove(runners, request.owner);
          }),
        );
      },
    );

    const watch: Interface["watch"] = (owner) => {
      const changes = pipe(
        SubscriptionRef.changes(state),
        Stream.map((current) => Option.getOrNull(HashMap.get(current, owner))),
        Stream.changes,
        Stream.map((entry) => new Changed({ entry })),
      );
      const fired = pipe(
        Stream.fromPubSub(triggers),
        Stream.filter((trigger) => trigger.owner === owner),
        Stream.map((trigger) => trigger.event),
      );
      return Stream.merge(changes, fired);
    };

    return Service.of({ start, get, stop, watch });
  }),
);
