import {
  Chunk,
  Context,
  Data,
  Effect,
  Layer,
  pipe,
  Predicate,
  Queue,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { context as zeroMqContext, Dealer, Subscriber } from "zeromq";
import { messageFrom } from "#o/error";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const MESSAGE_QUEUE_CAPACITY = 64;
const SEND_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

export class Endpoint extends Data.Class<{
  readonly host: string;
  readonly port: number;
}> {
  readonly address = `tcp://${this.host}:${this.port}`;
}

export class OpenFailed extends Data.TaggedError("ZeroMqTransportFailed")<{
  readonly operation: string;
  readonly message: string;
}> {}

export class Receiver extends Data.Class<{
  readonly receive: Effect.Effect<Chunk.Chunk<Uint8Array>, OpenFailed>;
}> {}

export class DealerChannel extends Data.Class<{
  readonly send: (
    frames: Chunk.Chunk<Uint8Array>,
  ) => Effect.Effect<void, OpenFailed>;
  readonly receive: Effect.Effect<Chunk.Chunk<Uint8Array>, OpenFailed>;
}> {}

export type Interface = Readonly<{
  dealer: (
    endpoint: Endpoint,
  ) => Effect.Effect<DealerChannel, OpenFailed, Scope.Scope>;
  subscriber: (
    endpoint: Endpoint,
  ) => Effect.Effect<Receiver, OpenFailed, Scope.Scope>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "orogeny/Jupyter.Transport",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      zeroMqContext.blocky = false;
    });

    const configure = <Socket extends Dealer | Subscriber>(
      socket: Socket,
    ): Socket => {
      socket.handshakeInterval = HANDSHAKE_TIMEOUT_MS;
      socket.linger = 0;
      socket.maxMessageSize = MAX_MESSAGE_BYTES;
      return socket;
    };

    const acquireDealer = (endpoint: Endpoint) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            const socket = configure(new Dealer());
            socket.sendTimeout = SEND_TIMEOUT_MS;
            socket.connect(endpoint.address);
            return socket;
          },
          catch: (cause) =>
            new OpenFailed({
              operation: `connect ZeroMQ dealer to ${endpoint.address}`,
              message: messageFrom(cause),
            }),
        }),
        (socket) => Effect.sync(() => socket.close()),
      );

    const acquireSubscriber = (endpoint: Endpoint) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            const socket = configure(new Subscriber());
            socket.subscribe();
            socket.connect(endpoint.address);
            return socket;
          },
          catch: (cause) =>
            new OpenFailed({
              operation: `connect ZeroMQ subscriber to ${endpoint.address}`,
              message: messageFrom(cause),
            }),
        }),
        (socket) => Effect.sync(() => socket.close()),
      );

    const makeReceiver = Effect.fn("Jupyter.Transport.__makeReceiver")(
      function* (socket: Dealer | Subscriber, operation: string) {
        const messages = yield* pipe(
          Stream.fromAsyncIterable(
            socket,
            (cause) =>
              new OpenFailed({
                operation,
                message: messageFrom(cause),
              }),
          ),
          Stream.map((frames) => Chunk.fromIterable<Uint8Array>(frames)),
          Stream.toQueue({ capacity: MESSAGE_QUEUE_CAPACITY }),
        );

        // Stream.toQueue owns a receive pump. Registering this finalizer
        // afterward closes the socket before that pump during teardown.
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));

        const receive = Queue.take(messages).pipe(
          Effect.mapError((cause) =>
            Predicate.isTagged(cause, "ZeroMqTransportFailed")
              ? cause
              : new OpenFailed({
                  operation,
                  message: "The ZeroMQ peer closed the channel",
                }),
          ),
        );
        return new Receiver({ receive });
      },
    );

    const dealer: Interface["dealer"] = Effect.fn("Jupyter.Transport.dealer")(
      function* (endpoint) {
        const socket = yield* acquireDealer(endpoint);
        const receiver = yield* makeReceiver(
          socket,
          `receive ZeroMQ dealer message from ${endpoint.address}`,
        );
        const writes = yield* Semaphore.make(1);
        const send: DealerChannel["send"] = (frames) =>
          writes.withPermit(
            Effect.tryPromise({
              try: () => socket.send(Array.from(frames)),
              catch: (cause) =>
                new OpenFailed({
                  operation: `send ZeroMQ dealer message to ${endpoint.address}`,
                  message: messageFrom(cause),
                }),
            }),
          );
        return new DealerChannel({ send, receive: receiver.receive });
      },
    );

    const subscriber: Interface["subscriber"] = Effect.fn(
      "Jupyter.Transport.subscriber",
    )(function* (endpoint) {
      const socket = yield* acquireSubscriber(endpoint);
      return yield* makeReceiver(
        socket,
        `receive ZeroMQ subscriber message from ${endpoint.address}`,
      );
    });

    return Service.of({ dealer, subscriber });
  }),
);

export * as Transport from "./transport.ts";
