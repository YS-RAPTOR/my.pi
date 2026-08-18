import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ProjectTrustContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { Host } from "../host/index.ts";
import { Barriers } from "./barriers/index.ts";
import { Interceptors } from "./interceptors/index.ts";
import { Notifications } from "./notifications/index.ts";

type HookType =
  | Barriers.BarrierType
  | Interceptors.InterceptorType
  | Notifications.NotificationType;

type PiEvent<Type extends HookType> = Extract<ExtensionEvent, { type: Type }>;

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
    // SAFETY: On preserves ExtensionAPI.on's event-to-context correlation while exposing its generic form.
    const on = pi.on.bind(pi) as On;

    for (const type of notificationTypes) {
      on(type, (event, callbackContext) => {
        // SAFETY: the registered notification type came from Notifications.handled.
        const notification = event as Notifications.Value;
        return runPromise(
          notifications.publish(notification, callbackContext),
          { signal: callbackContext.signal },
        );
      });
    }

    for (const type of barrierTypes) {
      on(type, (event, callbackContext) => {
        // SAFETY: the registered barrier type came from Barriers.handled.
        const barrier = event as Barriers.Value;
        return runPromise(
          Host.provideCallback(barriers.dispatch(barrier), callbackContext),
          { signal: callbackContext.signal },
        );
      });
    }

    for (const registration of interceptorRegistrations) {
      if (registration.type === "project_trust") {
        // SAFETY: the discriminant check narrows this registration to project_trust.
        const current =
          registration as Interceptors.RegistrationOf<"project_trust">;
        on(current.type, (event, callbackContext) => {
          // SAFETY: Pi supplies the event matching the registered project_trust type.
          const interceptor =
            event as Interceptors.InterceptorOf<"project_trust">;
          return runPromise(
            Host.provideProjectTrust(
              current.handler(interceptor),
              callbackContext,
            ),
          );
        });
        continue;
      }

      type ContextualType = Exclude<
        Interceptors.InterceptorType,
        "project_trust"
      >;
      // SAFETY: project_trust was excluded by the preceding discriminant branch.
      const current =
        registration as Interceptors.RegistrationOf<ContextualType>;
      on(current.type, (event, callbackContext) => {
        // SAFETY: Pi supplies the event matching the registered interceptor type.
        const interceptor = event as Interceptors.InterceptorOf<ContextualType>;
        return runPromise(
          Host.provideCallback(current.handler(interceptor), callbackContext),
          { signal: callbackContext.signal },
        );
      });
    }
  });
});

export { Barriers } from "./barriers/index.ts";
export { Interceptors } from "./interceptors/index.ts";
export { Notifications } from "./notifications/index.ts";
export * as Hooks from "./index.ts";
