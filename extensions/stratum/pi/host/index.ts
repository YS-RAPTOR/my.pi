import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProjectTrustContext as PiProjectTrustContext,
} from "@earendil-works/pi-coding-agent";
import { Context as EffectContext, Effect, Layer, pipe } from "effect";
import * as AgentState from "./agent-state.ts";
import * as SessionView from "./session-view.ts";
import * as UI from "./ui.ts";

export type Interface = Readonly<{
  agent: AgentState.Global;
  session: SessionView.Global;
}>;

export type CallbackInterface = Readonly<{
  agent: AgentState.Callback;
  session: SessionView.Callback;
  ui: UI.Interface;
}>;

export type CommandInterface = Readonly<{
  agent: AgentState.Command;
  session: SessionView.Command;
}>;

export type ProjectTrustInterface = Readonly<{
  session: SessionView.ProjectTrust;
  ui: UI.ProjectTrust;
}>;

export class Service extends EffectContext.Service<Service, Interface>()(
  "stratum/Pi.Host",
) {}

export class Callback extends EffectContext.Service<
  Callback,
  CallbackInterface
>()("stratum/Pi.Host.Callback") {}

export class CallbackContext extends EffectContext.Service<
  CallbackContext,
  ExtensionContext
>()("stratum/Pi.Host.CallbackContext") {}

export class Command extends EffectContext.Service<
  Command,
  CommandInterface
>()("stratum/Pi.Host.Command") {}

export class CommandContext extends EffectContext.Service<
  CommandContext,
  ExtensionCommandContext
>()("stratum/Pi.Host.CommandContext") {}

export class ProjectTrust extends EffectContext.Service<
  ProjectTrust,
  ProjectTrustInterface
>()("stratum/Pi.Host.ProjectTrust") {}

export class ProjectTrustContext extends EffectContext.Service<
  ProjectTrustContext,
  PiProjectTrustContext
>()("stratum/Pi.Host.ProjectTrustContext") {}

export const layer = (pi: ExtensionAPI) =>
  Layer.succeed(
    Service,
    Service.of({
      agent: AgentState.global(pi),
      session: SessionView.global(pi),
    }),
  );

export const provideCallback = Effect.fn("Pi.Host.provideCallback")(
  function* <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
    callbackContext: ExtensionContext,
  ) {
    return yield* pipe(
      effect,
      Effect.provideService(
        Callback,
        Callback.of({
          agent: AgentState.callback(callbackContext),
          session: SessionView.callback(callbackContext),
          ui: UI.from(callbackContext),
        }),
      ),
      Effect.provideService(CallbackContext, callbackContext),
    );
  },
);

export const provideProjectTrust = Effect.fn(
  "Pi.Host.provideProjectTrust",
)(function* <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
  context: PiProjectTrustContext,
) {
  return yield* pipe(
    effect,
    Effect.provideService(
      ProjectTrust,
      ProjectTrust.of({
        session: SessionView.projectTrust(context),
        ui: UI.fromProjectTrust(context),
      }),
    ),
    Effect.provideService(ProjectTrustContext, context),
  );
});

export const provideCommand = Effect.fn("Pi.Host.provideCommand")(
  function* <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
    callbackContext: ExtensionCommandContext,
  ) {
    return yield* pipe(
      effect,
      Effect.provideService(
        Callback,
        Callback.of({
          agent: AgentState.callback(callbackContext),
          session: SessionView.callback(callbackContext),
          ui: UI.from(callbackContext),
        }),
      ),
      Effect.provideService(CallbackContext, callbackContext),
      Effect.provideService(CommandContext, callbackContext),
      Effect.provideService(
        Command,
        Command.of({
          agent: AgentState.command(callbackContext),
          session: SessionView.command(callbackContext),
        }),
      ),
    );
  },
);

export { AgentState, SessionView, UI };
export * as Host from "./index.ts";
