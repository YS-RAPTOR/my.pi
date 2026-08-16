import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Chunk,
  Context,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Option,
  pipe,
  PubSub,
  Stream,
  SynchronizedRef,
} from "effect";
import { Host } from "#s/pi/host";
import { Notification } from "./types.ts";

export type Value = typeof Notification.Type;
export type NotificationType = Value["type"];
export type NotificationOf<Type extends NotificationType> = Extract<
  Value,
  { readonly type: Type }
>;
export type Handled = Array<NotificationType>;

export type Listener<Type extends NotificationType, Error = never> = (
  notification: NotificationOf<Type>,
) => Effect.Effect<
  void,
  Error,
  Host.Service | Host.Callback | Host.CallbackContext
>;

type AnyListener = (
  notification: Value,
) => Effect.Effect<
  void,
  unknown,
  Host.Service | Host.Callback | Host.CallbackContext
>;
type ListenerBucket = SynchronizedRef.SynchronizedRef<Chunk.Chunk<AnyListener>>;
type Listeners = HashMap.HashMap<NotificationType, ListenerBucket>;

export type Interface = Readonly<{
  handled: Effect.Effect<Handled>;
  publish: (
    notification: Value,
    context: ExtensionContext,
  ) => Effect.Effect<void, never, Host.Service>;
  subscribe: <const Types extends [NotificationType, ...NotificationType[]]>(
    ...types: Types
  ) => Effect.Effect<Stream.Stream<NotificationOf<Types[number]>>>;
  listen: <
    const Types extends readonly [NotificationType, ...NotificationType[]],
    Error,
  >(
    types: Types,
    listener: Listener<Types[number], Error>,
  ) => Effect.Effect<void>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Pi.Hooks.Notifications",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const topics = yield* SynchronizedRef.make(
      HashMap.empty<NotificationType, PubSub.PubSub<Value>>(),
    );
    const listeners = yield* SynchronizedRef.make<Listeners>(HashMap.empty());

    const getOrCreate = Effect.fn("Pi.Hooks.Notifications.__getOrCreate")(
      function* <Key, Entry, Error, Requirements>(
        registry: SynchronizedRef.SynchronizedRef<HashMap.HashMap<Key, Entry>>,
        key: Key,
        create: Effect.Effect<Entry, Error, Requirements>,
      ) {
        return yield* SynchronizedRef.modifyEffect(
          registry,
          Effect.fn("Pi.Hooks.Notifications.__getOrCreate.modify")(
            function* (current) {
              const existing = HashMap.get(current, key);
              if (Option.isSome(existing)) {
                return [existing.value, current] as const;
              }
              const entry = yield* create;
              return [entry, HashMap.set(current, key, entry)] as const;
            },
          ),
        );
      },
    );

    const handled: Interface["handled"] = pipe(
      Effect.all({
        topics: SynchronizedRef.get(topics),
        listeners: SynchronizedRef.get(listeners),
      }),
      Effect.map(({ topics: currentTopics, listeners: currentListeners }) =>
        Array.from(
          HashSet.union(
            HashSet.fromIterable(HashMap.keys(currentTopics)),
            HashSet.fromIterable(HashMap.keys(currentListeners)),
          ),
        ),
      ),
      Effect.withSpan("Pi.Hooks.Notifications.handled"),
    );

    const publish: Interface["publish"] = Effect.fn(
      "Pi.Hooks.Notifications.publish",
    )(function* (notification, context) {
      const currentTopics = yield* SynchronizedRef.get(topics);
      const topic = HashMap.get(currentTopics, notification.type);
      if (Option.isSome(topic)) {
        yield* PubSub.publish(topic.value, notification);
      }

      const currentListeners = yield* SynchronizedRef.get(listeners);
      const bucket = HashMap.get(currentListeners, notification.type);
      const handlers = Option.isSome(bucket)
        ? yield* SynchronizedRef.get(bucket.value)
        : Chunk.empty<AnyListener>();
      yield* Effect.forEach(
        handlers,
        (handler) =>
          pipe(
            Host.provideCallback(handler(notification), context),
            Effect.exit,
            Effect.forkDetach,
          ),
        { discard: true },
      );
    });

    const subscribe: Interface["subscribe"] = Effect.fn(
      "Pi.Hooks.Notifications.subscribe",
    )(function* <const Types extends [NotificationType, ...NotificationType[]]>(
      ...types: Types
    ) {
      const streams = yield* Effect.forEach(
        HashSet.fromIterable(types),
        (type) =>
          pipe(
            getOrCreate(topics, type, PubSub.unbounded<Value>()),
            Effect.map(Stream.fromPubSub),
          ),
      );
      return Stream.mergeAll(streams, {
        concurrency: "unbounded",
      }) as Stream.Stream<NotificationOf<Types[number]>>;
    });

    const listen: Interface["listen"] = Effect.fn(
      "Pi.Hooks.Notifications.listen",
    )(function* <
      const Types extends readonly [NotificationType, ...NotificationType[]],
      Error,
    >(types: Types, listener: Listener<Types[number], Error>) {
      const erased: AnyListener = (notification) =>
        listener(
          notification as NotificationOf<Types[number]>,
        ) as Effect.Effect<
          void,
          Error,
          Host.Service | Host.Callback | Host.CallbackContext
        >;
      for (const type of HashSet.fromIterable(types)) {
        const bucket = yield* getOrCreate(
          listeners,
          type,
          SynchronizedRef.make(Chunk.empty<AnyListener>()),
        );
        yield* SynchronizedRef.update(bucket, (handlers) =>
          Chunk.append(handlers, erased),
        );
      }
    });

    yield* Effect.addFinalizer(
      Effect.fn("Pi.Hooks.Notifications.__shutdown")(function* () {
        const current = yield* SynchronizedRef.get(topics);
        yield* Effect.forEach(HashMap.values(current), PubSub.shutdown, {
          discard: true,
        });
      }),
    );

    return Service.of({ handled, publish, subscribe, listen });
  }),
);

export * from "./types.ts";
export * as Notifications from "./index.ts";
