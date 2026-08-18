import {
  Chunk,
  Context,
  Effect,
  Exit,
  HashMap,
  Layer,
  Option,
  pipe,
  SynchronizedRef,
} from "effect";
import { Host } from "../../host/index.ts";
import { Barrier } from "./types.ts";

export type Value = typeof Barrier.Type;
export type BarrierType = Value["type"];
export type BarrierOf<Type extends BarrierType> = Extract<
  Value,
  { readonly type: Type }
>;
export type Handler<Type extends BarrierType> = (
  barrier: BarrierOf<Type>,
) => Effect.Effect<
  void,
  never,
  Host.Service | Host.Callback | Host.CallbackContext
>;

type AnyHandler = (
  barrier: Value,
) => Effect.Effect<
  void,
  never,
  Host.Service | Host.Callback | Host.CallbackContext
>;
type State = HashMap.HashMap<BarrierType, Chunk.Chunk<AnyHandler>>;

export type Interface = Readonly<{
  handled: Effect.Effect<Array<BarrierType>>;
  handle: <Type extends BarrierType>(
    type: Type,
    handler: Handler<Type>,
  ) => Effect.Effect<void>;
  dispatch: (
    barrier: Value,
  ) => Effect.Effect<
    void,
    never,
    Host.Service | Host.Callback | Host.CallbackContext
  >;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "@ys-raptor/pi-effect/Hooks.Barriers",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<State>(HashMap.empty());

    const handled: Interface["handled"] = pipe(
      SynchronizedRef.get(state),
      Effect.map((current) => Array.from(HashMap.keys(current))),
      Effect.withSpan("Pi.Hooks.Barriers.handled"),
    );

    const handle: Interface["handle"] = Effect.fn("Pi.Hooks.Barriers.handle")(
      function* <Type extends BarrierType>(type: Type, handler: Handler<Type>) {
        const erased: AnyHandler = Effect.fn("Pi.Hooks.Barriers.__handle")(
          function* (barrier) {
            // SAFETY: this erased handler is stored only under its matching barrier type.
            yield* handler(barrier as BarrierOf<Type>);
          },
        );
        yield* SynchronizedRef.update(state, (current) => {
          const handlers = Option.getOrElse(
            HashMap.get(current, type),
            Chunk.empty,
          );
          return HashMap.set(current, type, Chunk.append(handlers, erased));
        });
      },
    );

    const dispatch: Interface["dispatch"] = Effect.fn(
      "Pi.Hooks.Barriers.dispatch",
    )(function* (barrier) {
      const current = yield* SynchronizedRef.get(state);
      const handlers = Option.getOrElse(
        HashMap.get(current, barrier.type),
        Chunk.empty,
      );
      const exits = yield* Effect.forEach(
        handlers,
        (handler) => Effect.exit(handler(barrier)),
        { concurrency: "unbounded" },
      );
      const combined = Exit.asVoidAll(exits);
      if (Exit.isFailure(combined)) {
        return yield* Effect.failCause(combined.cause);
      }
    });

    return Service.of({ handled, handle, dispatch });
  }),
);

export * from "./types.ts";
export * as Barriers from "./index.ts";
