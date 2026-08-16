import {
  Array as Arr,
  Cause,
  Chunk,
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Order,
  SynchronizedRef,
  pipe,
} from "effect";
import { Host } from "#s/pi/host";
import { Interceptor, ResultByType } from "./types.ts";

export type Value = typeof Interceptor.Type;
export type InterceptorType = Value["type"];
export type InterceptorOf<Type extends InterceptorType> = Extract<
  Value,
  { readonly type: Type }
>;

export type ResultOf<Type extends InterceptorType> =
  (typeof ResultByType)[Type]["Type"];

export type HandlerResult<Type extends InterceptorType> =
  Type extends "project_trust" ? ResultOf<Type> : ResultOf<Type> | void;

type HandlerRequirements<Type extends InterceptorType> =
  Type extends "project_trust"
    ? Host.ProjectTrust | Host.ProjectTrustContext
    : Host.Service | Host.Callback | Host.CallbackContext;

export type Handler<Type extends InterceptorType> = (
  event: InterceptorOf<Type>,
) => Effect.Effect<HandlerResult<Type>, never, HandlerRequirements<Type>>;

export type RegistrationOf<Type extends InterceptorType> = Readonly<{
  type: Type;
  order: number;
  handler: Handler<Type>;
}>;

export type Registration = {
  [Type in InterceptorType]: RegistrationOf<Type>;
}[InterceptorType];

type State = HashMap.HashMap<InterceptorType, Chunk.Chunk<Registration>>;

export type Interface = Readonly<{
  registrations: Effect.Effect<Array<Registration>>;
  handle: <Type extends InterceptorType>(
    type: Type,
    order: number,
    handler: Handler<Type>,
  ) => Effect.Effect<void>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Pi.Hooks.Interceptors",
) {}

const registrationOrder = Order.make<Registration>((left, right) => {
  const order = Order.Number(left.order, right.order);
  return order !== 0 ? order : Order.String(left.type, right.type);
});

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<State>(HashMap.empty());

    const registrations: Interface["registrations"] = pipe(
      SynchronizedRef.get(state),
      Effect.map((current) =>
        pipe(
          HashMap.values(current),
          Arr.fromIterable,
          Arr.flatMap(Arr.fromIterable),
          Arr.sort(registrationOrder),
        ),
      ),
      Effect.withSpan("Pi.Hooks.Interceptors.registrations"),
    );

    const handle: Interface["handle"] = Effect.fn(
      "Pi.Hooks.Interceptors.handle",
    )(function* <Type extends InterceptorType>(
      type: Type,
      order: number,
      handler: Handler<Type>,
    ) {
      if (!globalThis.Number.isFinite(order)) {
        return yield* Effect.die(
          new Cause.IllegalArgumentError(
            `Interceptor order for ${type} must be finite`,
          ),
        );
      }
      const registration: RegistrationOf<Type> = { type, order, handler };
      yield* SynchronizedRef.modifyEffect(
        state,
        Effect.fn("Pi.Hooks.Interceptors.__register")(function* (current) {
          const existing = Option.getOrElse(
            HashMap.get(current, type),
            Chunk.empty,
          );
          if (Chunk.some(existing, (entry) => entry.order === order)) {
            return yield* Effect.die(
              new Cause.IllegalArgumentError(
                `Interceptor order ${order} is already registered for ${type}`,
              ),
            );
          }
          // SAFETY: the map key retains the registration's matching interceptor type.
          const erased = registration as RegistrationOf<Type> & Registration;
          return [
            undefined,
            HashMap.set(current, type, Chunk.append(existing, erased)),
          ];
        }),
      );
    });

    return Service.of({ registrations, handle });
  }),
);

export * from "./types.ts";
export * as Interceptors from "./index.ts";
