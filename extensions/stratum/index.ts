import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Config } from "./config.ts";
import { Pi } from "./pi/index.ts";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

export const layer = (pi: ExtensionAPI) =>
  Layer.mergeAll(
    Config.layer.pipe(Layer.provide(platform)),
    Pi.Host.layer(pi),
    Pi.Contributions.layer,
    Pi.Hooks.layer,
  );

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

export { Config } from "./config.ts";
export { Pi } from "./pi/index.ts";
export default Stratum;
