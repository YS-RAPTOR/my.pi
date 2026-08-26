import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
export type Invocation = Readonly<
  Pick<ExtensionContext, "mode" | "model" | "modelRegistry" | "signal">
>;

export type Definition<Error = unknown> = Readonly<{
  description: string;
  loadingMessage: string;
  errorMessage: string;
  rewrite: (input: string, context: Invocation) => Effect.Effect<string | null, Error>;
}>;

export type Registration = Readonly<{
  name: string;
  definition: Definition;
}>;

export type Interface = Readonly<{
  register: <Error>(name: string, definition: Definition<Error>) => Effect.Effect<void>;
  list: Effect.Effect<Array<Registration>>;
}>;

export class Service extends Context.Service<Service, Interface>()("stratum/Rewriters/Register") {}

const namePattern = /^[a-z][a-z0-9_-]*$/;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registrations = yield* SynchronizedRef.make(HashMap.empty<string, Registration>());

    const register: Interface["register"] = Effect.fn("Features.Rewriters.Register.register")(
      function* (name, definition) {
        if (!namePattern.test(name)) {
          return yield* Effect.die(
            new Cause.IllegalArgumentError(
              `Rewriter name ${JSON.stringify(name)} must match ${namePattern}`,
            ),
          );
        }
        yield* SynchronizedRef.updateEffect(registrations, (current) =>
          pipe(
            Match.value(HashMap.has(current, name)),
            Match.when(true, () =>
              Effect.die(
                new Cause.IllegalArgumentError(
                  `Rewriter ${JSON.stringify(name)} is already registered`,
                ),
              ),
            ),
            Match.when(false, () =>
              Effect.succeed(
                HashMap.set(current, name, {
                  name,
                  // SAFETY: registration erases only the rewriter-specific error type.
                  definition: definition as Definition,
                }),
              ),
            ),
            Match.exhaustive,
          ),
        );
      },
    );

    const list = pipe(
      SynchronizedRef.get(registrations),
      Effect.map((current) =>
        pipe(
          HashMap.values(current),
          Arr.fromIterable,
          Arr.sortWith((registration) => registration.name, Order.String),
        ),
      ),
      Effect.withSpan("Features.Rewriters.Register.list"),
    );

    return Service.of({ register, list });
  }),
);

export * as Register from "./register.ts";
