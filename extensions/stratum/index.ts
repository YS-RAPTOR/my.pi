import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Config } from "#s/config";
import { Activity } from "#s/features/activity";
import { BetterSkills } from "#s/features/better-skills";
import { Commands } from "#s/features/commands";
import { Footer } from "#s/features/footer";
import { Rewriters } from "#s/features/rewriters";

const platform = NodeServices.layer;

const configured = <A, E, R>(make: (config: Config.Value) => Layer.Layer<A, E, R>) =>
  Layer.unwrap(pipe(Config.Service, Effect.map(make)));

export const layer = (pi: ExtensionAPI) => {
  const config = pipe(Config.layer, Layer.provide(platform));
  const dependencies = Layer.mergeAll(
    platform,
    config,
    Pi.Host.layer(pi),
    Pi.Contributions.layer,
    Pi.Hooks.layer,
    Rewriters.Register.layer,
  );

  const activity = configured(({ activity }) => (activity.enabled ? Activity.layer : Layer.empty));

  const betterSkills = configured(({ "better-skills": settings }) => {
    if (!settings.enabled) return Layer.empty;
    const runtime = BetterSkills.Runtime.layer;
    const gating = pipe(
      BetterSkills.Gating.layer,
      Layer.provide(BetterSkills.Gating.Catalog.layer),
    );
    const features = pipe(
      Layer.mergeAll(
        settings.expansion ? BetterSkills.Expansion.layer : Layer.empty,
        settings.gating ? gating : Layer.empty,
        settings.inline ? BetterSkills.Inline.layer : Layer.empty,
      ),
      Layer.provide(runtime),
    );
    return Layer.merge(runtime, features);
  });

  const commands = configured(({ commands: settings }) => {
    if (!settings.enabled) return Layer.empty;
    return Layer.mergeAll(
      settings["home-autocomplete"].enabled ? Commands.HomeAutocomplete.layer : Layer.empty,
      settings.stretch.enabled ? Commands.Stretch.layer : Layer.empty,
    );
  });

  const footer = configured(({ footer }) =>
    footer.enabled
      ? pipe(
          Footer.layer,
          Layer.provide(footer.runway.enabled ? Footer.Runway.layer : Footer.Runway.disabledLayer),
        )
      : Layer.empty,
  );

  const rewriters = configured(({ rewriters }) =>
    rewriters.enabled
      ? Layer.merge(Rewriters.layer, rewriters.clarify ? Rewriters.Clarify.layer : Layer.empty)
      : Layer.empty,
  );

  const features = pipe(
    Layer.mergeAll(activity, betterSkills, commands, footer, rewriters),
    Layer.provide(dependencies),
  );
  return Layer.merge(dependencies, features);
};

const Stratum = async (pi: ExtensionAPI): Promise<void> => {
  const runtime = ManagedRuntime.make(layer(pi));
  await runtime.runPromise(
    Effect.gen(function* () {
      yield* Pi.Contributions.register(pi);
      yield* Pi.Hooks.register(pi);
    }),
  );
  pi.on("session_shutdown", () => runtime.dispose());
};

export { Config } from "#s/config";
export { Activity } from "#s/features/activity";
export { BetterSkills } from "#s/features/better-skills";
export { Commands } from "#s/features/commands";
export { Footer } from "#s/features/footer";
export { Rewriters } from "#s/features/rewriters";
export { Pi } from "@ys-raptor/pi-effect";
export default Stratum;
