import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Config } from "#o/config";
import { Prelude } from "#o/prelude";
import { Session } from "#o/session";
import { Syntax } from "#o/syntax";
import { Tools } from "#o/tools";

const platform = NodeServices.layer;

export const layer = (pi: ExtensionAPI) => {
  const config = pipe(Config.layer, Layer.provide(platform));
  const syntax = pipe(Syntax.layer, Layer.provide(config));
  const prelude = Prelude.layer;
  const syntaxPrelude = pipe(
    Syntax.Prelude.layer,
    Layer.provide(Layer.merge(syntax, prelude)),
  );
  const dependencies = Layer.mergeAll(
    platform,
    config,
    syntax,
    prelude,
    syntaxPrelude,
    Pi.Host.layer(pi),
    Pi.Contributions.layer,
    Pi.Hooks.layer,
  );
  const session = pipe(Session.layer, Layer.provide(dependencies));
  const services = Layer.merge(dependencies, session);
  const tools = pipe(Tools.layer, Layer.provide(services));
  return Layer.merge(services, tools);
};

const Orogeny = async (pi: ExtensionAPI): Promise<void> => {
  const runtime = ManagedRuntime.make(layer(pi));
  await runtime.runPromise(
    Effect.gen(function* () {
      yield* Pi.Contributions.register(pi);
      yield* Pi.Hooks.register(pi);
    }),
  );
  pi.on("session_shutdown", () => runtime.dispose());
};

export { Config } from "#o/config";
export { Session } from "#o/session";
export { Syntax } from "#o/syntax";
export default Orogeny;
