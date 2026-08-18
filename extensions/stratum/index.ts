import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { Config } from "#s/config";
import { Activity } from "#s/features/activity";
import { BetterSkills } from "#s/features/better-skills";
import { Footer } from "#s/features/footer";
import { Shell } from "#s/features/shell";
import { Pi } from "@ys-raptor/pi-effect";

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
    pipe(Footer.layer, Layer.provide(dependencies)),
    shell,
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
export { Footer } from "#s/features/footer";
export { Shell } from "#s/features/shell";
export { Pi } from "@ys-raptor/pi-effect";
export default Stratum;
