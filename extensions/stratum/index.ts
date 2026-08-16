import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { Config } from "#s/config";
import { Activity } from "#s/features/activity";
import { BetterSkills } from "#s/features/better-skills";
import { Shell } from "#s/features/shell";
import { Frame } from "#s/frame";
import { Pi } from "#s/pi";

const platform = NodeServices.layer;

export const layer = (pi: ExtensionAPI) => {
  const dependencies = Layer.mergeAll(
    platform,
    pipe(Config.layer, Layer.provide(platform)),
    Pi.Host.layer(pi),
    Pi.Contributions.layer,
    Pi.Hooks.layer,
  );
  const activity = pipe(Activity.layer, Layer.provide(dependencies));
  const shell = pipe(Shell.layer, Layer.provide(dependencies));
  return Layer.mergeAll(
    dependencies,
    pipe(BetterSkills.layer, Layer.provide(dependencies)),
    activity,
    shell,
    pipe(
      Frame.layer,
      Layer.provide(Layer.merge(dependencies, shell)),
    ),
  );
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
export { Shell } from "#s/features/shell";
export { Frame } from "#s/frame";
export { Pi } from "#s/pi";
export default Stratum;
