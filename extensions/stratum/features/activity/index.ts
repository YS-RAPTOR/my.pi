import { Effect, Layer, pipe } from "effect";
import { Hooks } from "#s/pi/hooks";
import { Service, serviceLayer } from "./service.ts";

const hookLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const activity = yield* Service;
    const notifications = yield* Hooks.Notifications.Service;
    yield* notifications.listen(["agent_start"], () => activity.agentStarted);
    yield* notifications.listen(["agent_end", "agent_settled"], () =>
      activity.agentEnded,
    );
  }),
);

export const layer = Layer.merge(
  serviceLayer,
  pipe(hookLayer, Layer.provide(serviceLayer)),
);

export { type Interface, Service } from "./service.ts";
export * from "./types.ts";
export * as Activity from "./index.ts";
