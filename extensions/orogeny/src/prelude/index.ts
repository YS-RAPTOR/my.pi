import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  HashMap,
  Layer,
  Match,
  Order,
  SynchronizedRef,
  pipe,
} from "effect";

export type Registration = Readonly<{
  name: string;
  source: string;
}>;

export type Interface = Readonly<{
  register: (name: string, source: string) => Effect.Effect<void>;
  get: Effect.Effect<string>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Prelude") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registrations = yield* SynchronizedRef.make(HashMap.empty<string, Registration>());

    const register: Interface["register"] = Effect.fn("Orogeny.Prelude.register")(
      function* (name, source) {
        yield* SynchronizedRef.updateEffect(registrations, (current) =>
          pipe(
            Match.value(HashMap.has(current, name)),
            Match.when(true, () =>
              Effect.die(
                new Cause.IllegalArgumentError(
                  `Prelude ${JSON.stringify(name)} is already registered`,
                ),
              ),
            ),
            Match.when(false, () => Effect.succeed(HashMap.set(current, name, { name, source }))),
            Match.exhaustive,
          ),
        );
      },
    );

    const get: Interface["get"] = pipe(
      SynchronizedRef.get(registrations),
      Effect.map((current) =>
        pipe(
          HashMap.values(current),
          Arr.fromIterable,
          Arr.sortWith((registration) => registration.name, Order.String),
          Arr.map((registration) => registration.source),
          Arr.join("\n\n"),
        ),
      ),
      Effect.withSpan("Orogeny.Prelude.get"),
    );

    return Service.of({ register, get });
  }),
);

export * as Prelude from "./index.ts";
