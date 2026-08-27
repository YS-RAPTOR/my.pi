import { createServer } from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Bridge } from "#o/bridge";
import { Config } from "#o/config";
import { Jupyter } from "#o/jupyter";
import { Notebook } from "#o/notebook";
import { CellOutput } from "#o/output";
import { PiTools } from "#o/pi";
import { Prelude } from "#o/prelude";
import { Session } from "#o/session";
import { Syntax } from "#o/syntax";
import { Tools } from "#o/tools";

const platform = NodeServices.layer;

export const layer = (pi: ExtensionAPI) => {
  const config = pipe(Config.layer, Layer.provide(platform));
  const syntax = pipe(Syntax.layer, Layer.provide(config));
  const prelude = Prelude.layer;
  const bridge = pipe(
    Bridge.layer,
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
  );
  const jupyter = pipe(Jupyter.layer, Layer.provide(platform));
  const output = pipe(CellOutput.layer, Layer.provide(platform));
  const syntaxPrelude = pipe(
    Syntax.Prelude.layer,
    Layer.provide(Layer.merge(syntax, prelude)),
  );
  const piTools = pipe(PiTools.layer, Layer.provide(bridge));
  const piPrelude = pipe(PiTools.Prelude.layer, Layer.provide(prelude));
  const runtime = Layer.mergeAll(
    platform,
    config,
    syntax,
    prelude,
    bridge,
    jupyter,
    output,
    syntaxPrelude,
    piTools,
    piPrelude,
  );
  const notebook = pipe(Notebook.layer, Layer.provide(runtime));
  const dependencies = Layer.mergeAll(
    runtime,
    notebook,
    Pi.Host.layer(pi),
    Pi.Contributions.layer,
    Pi.Hooks.layer,
  );
  const session = pipe(Session.layer, Layer.provide(dependencies));
  const services = Layer.merge(dependencies, session);
  const tools = pipe(
    Layer.mergeAll(
      Tools.Create.layer,
      Tools.List.layer,
      Tools.Push.layer,
      Tools.Stop.layer,
      Tools.Wait.layer,
    ),
    Layer.provide(services),
  );
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
