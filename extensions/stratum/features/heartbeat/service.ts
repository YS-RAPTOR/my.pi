import {
  Clock,
  Context,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  PlatformError,
  Ref,
  Semaphore,
  pipe,
} from "effect";
import { Activity } from "#s/features/activity";
import { Host } from "#s/pi/host";
import { Entry, Start } from "./types.ts";

export type Interface = Readonly<{
  start: (
    request: Start,
  ) => Effect.Effect<Entry, PlatformError.PlatformError>;
  get: Effect.Effect<Entry | null>;
  stop: Effect.Effect<void>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Heartbeat",
) {}

const heartbeatID = "heartbeat";
const activityLease = new Activity.Acquire({
  id: heartbeatID,
  reason: "Agent heartbeat active",
});
const activityRelease = new Activity.Release({ id: heartbeatID });

const nextRunAt = (now: number, request: Start | Entry) =>
  Math.min(
    now + request.intervalSeconds * 1_000,
    request.expiresAt ?? Number.POSITIVE_INFINITY,
  );

export const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const activity = yield* Activity.Service;
    const host = yield* Host.Service;
    const runner = yield* FiberHandle.make<void>();
    const current = yield* Ref.make<Entry | null>(null);
    const mutex = yield* Semaphore.make(1);

    const run = Effect.fn("Heartbeat.__run")(function* (started: Entry) {
      while (true) {
        const heartbeat = yield* Ref.get(current);
        if (heartbeat === null) return;
        const beforeSleep = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(
          Duration.millis(
            Math.max(0, heartbeat.nextRunAt - beforeSleep),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        if (started.expiresAt !== null && started.expiresAt <= now) return;
        yield* host.agent.sendUserMessage(started.instruction, {
          deliverAs: "followUp",
        });
        yield* Ref.update(current, (value) =>
          value === null
            ? null
            : new Entry({
                ...value,
                lastRunAt: now,
                nextRunAt: nextRunAt(now, value),
              }),
        );
      }
    });

    const start: Interface["start"] = Effect.fn("Heartbeat.start")(
      function* (request) {
        return yield* mutex.withPermit(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* FiberHandle.clear(runner);
              const now = yield* Clock.currentTimeMillis;
              const started = new Entry({
                ...request,
                startedAt: now,
                nextRunAt: nextRunAt(now, request),
                lastRunAt: null,
              });

              yield* restore(activity.acquire(activityLease));
              yield* Ref.set(current, started);
              const release = Effect.all(
                [activity.release(activityRelease), Ref.set(current, null)],
                { discard: true },
              );
              yield* pipe(
                run(started),
                Effect.ensuring(release),
                FiberHandle.run(runner),
                Effect.onError(() => release),
              );
              return started;
            }),
          ),
        );
      },
    );

    const get: Interface["get"] = pipe(
      Ref.get(current),
      Effect.withSpan("Heartbeat.get"),
    );

    const stop: Interface["stop"] = mutex
      .withPermit(
        pipe(FiberHandle.clear(runner), Effect.andThen(Ref.set(current, null))),
      )
      .pipe(Effect.withSpan("Heartbeat.stop"));

    return Service.of({ start, get, stop });
  }),
);
