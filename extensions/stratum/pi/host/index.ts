import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProjectTrustContext,
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

export class Command extends EffectContext.Service<
  Command,
  CommandInterface
>()("stratum/Pi.Host.Command") {}

export class ProjectTrust extends EffectContext.Service<
  ProjectTrust,
  ProjectTrustInterface
>()("stratum/Pi.Host.ProjectTrust") {}

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
    context: ExtensionContext,
  ) {
    return yield* Effect.provideService(
      effect,
      Callback,
      Callback.of({
        agent: AgentState.callback(context),
        session: SessionView.callback(context),
        ui: UI.from(context),
      }),
    );
  },
);

export const provideProjectTrust = Effect.fn(
  "Pi.Host.provideProjectTrust",
)(function* <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
  context: ProjectTrustContext,
) {
  return yield* Effect.provideService(
    effect,
    ProjectTrust,
    ProjectTrust.of({
      session: SessionView.projectTrust(context),
      ui: UI.fromProjectTrust(context),
    }),
  );
});

export const provideCommand = Effect.fn("Pi.Host.provideCommand")(
  function* <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
    context: ExtensionCommandContext,
  ) {
    return yield* pipe(
      effect,
      Effect.provideService(
        Callback,
        Callback.of({
          agent: AgentState.callback(context),
          session: SessionView.callback(context),
          ui: UI.from(context),
        }),
      ),
      Effect.provideService(
        Command,
        Command.of({
          agent: AgentState.command(context),
          session: SessionView.command(context),
        }),
      ),
    );
  },
);

export { AgentState, SessionView, UI };
export * as Host from "./index.ts";
