import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ProjectTrustContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { Host } from "#s/pi/host";
import { Barriers } from "./barriers/index.ts";
import { Interceptors } from "./interceptors/index.ts";
import { Notifications } from "./notifications/index.ts";

type HookType =
  | Barriers.BarrierType
  | Interceptors.InterceptorType
  | Notifications.NotificationType;

type PiEvent<Type extends HookType> = Extract<
  ExtensionEvent,
  { type: Type }
>;

type HookResult<Type extends HookType> =
  Type extends Interceptors.InterceptorType
    ? Interceptors.HandlerResult<Type>
    : void;

type CallbackContext<Type extends HookType> = Type extends "project_trust"
  ? ProjectTrustContext
  : ExtensionContext;

type On = <Type extends HookType>(
  type: Type,
  handler: (
    event: PiEvent<Type>,
    context: CallbackContext<Type>,
  ) => Promise<HookResult<Type>>,
) => void;

export const layer = Layer.mergeAll(
  Barriers.layer,
  Interceptors.layer,
  Notifications.layer,
);

export const register = Effect.fn("Pi.Hooks.register")(function* (
  pi: ExtensionAPI,
) {
  const barriers = yield* Barriers.Service;
  const interceptors = yield* Interceptors.Service;
  const notifications = yield* Notifications.Service;
  const barrierTypes = yield* barriers.handled;
  const notificationTypes = yield* notifications.handled;
  const interceptorRegistrations = yield* interceptors.registrations;
  const context = yield* Effect.context<
    | Host.Service
    | Barriers.Service
    | Interceptors.Service
    | Notifications.Service
  >();
  const runPromise = Effect.runPromiseWith(context);

  yield* Effect.sync(() => {
    const on = pi.on.bind(pi) as unknown as On;

    for (const type of notificationTypes) {
      on(type, (event, callbackContext) =>
        runPromise(
          notifications.publish(
            event as unknown as Notifications.Value,
            callbackContext,
          ),
          { signal: callbackContext.signal },
        ),
      );
    }

    for (const type of barrierTypes) {
      on(type, (event, callbackContext) =>
        runPromise(
          Host.provideCallback(
            barriers.dispatch(event as unknown as Barriers.Value),
            callbackContext,
          ),
          { signal: callbackContext.signal },
        ),
      );
    }

    for (const registration of interceptorRegistrations) {
      if (registration.type === "project_trust") {
        const current =
          registration as Interceptors.RegistrationOf<"project_trust">;
        on(current.type, (event, callbackContext) =>
          runPromise(
            Host.provideProjectTrust(
              current.handler(
                event as unknown as Interceptors.InterceptorOf<"project_trust">,
              ),
              callbackContext,
            ),
          ),
        );
        continue;
      }

      type ContextualType = Exclude<
        Interceptors.InterceptorType,
        "project_trust"
      >;
      const current =
        registration as Interceptors.RegistrationOf<ContextualType>;
      on(current.type, (event, callbackContext) =>
        runPromise(
          Host.provideCallback(
            current.handler(
              event as unknown as Interceptors.InterceptorOf<ContextualType>,
            ),
            callbackContext,
          ),
          { signal: callbackContext.signal },
        ),
      );
    }
  });
});

export { Barriers } from "./barriers/index.ts";
export { Interceptors } from "./interceptors/index.ts";
export { Notifications } from "./notifications/index.ts";
export * as Hooks from "./index.ts";
