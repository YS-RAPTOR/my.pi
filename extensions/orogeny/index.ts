import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { Layer, ManagedRuntime, pipe } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Config } from "#o/config";
import { Session } from "#o/session";

const platform = NodeServices.layer;

export const layer = (pi: ExtensionAPI) => {
  const dependencies = Layer.mergeAll(
    platform,
    pipe(Config.layer, Layer.provide(platform)),
    Pi.Host.layer(pi),
    Pi.Hooks.layer,
  );
  return Layer.mergeAll(dependencies, pipe(Session.layer, Layer.provide(dependencies)));
};

const Orogeny = async (pi: ExtensionAPI): Promise<void> => {
  pi.registerFlag("orogeny", {
    description: "Enable the Orogeny notebook runtime",
    type: "boolean",
    default: false,
  });

  const runtime = ManagedRuntime.make(layer(pi));
  await runtime.runPromise(Pi.Hooks.register(pi));
  pi.on("session_shutdown", () => runtime.dispose());
};

export { Config } from "#o/config";
export { Session } from "#o/session";
export default Orogeny;
