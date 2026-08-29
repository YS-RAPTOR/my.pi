import { createServer } from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Config as StratumConfig, Search, Shell as StratumShell } from "@ys-raptor/stratum.pi";
import { Bridge } from "#o/bridge";
import { Config } from "#o/config";
import { Jupyter } from "#o/jupyter";
import { Mcp } from "#o/mcp";
import { Notebook } from "#o/notebook";
import { CellOutput } from "#o/output";
import { PiTools } from "#o/pi";
import { Prelude } from "#o/prelude";
import { Session } from "#o/session";
import { Shell } from "#o/shell";
import { Syntax } from "#o/syntax";
import { Tools } from "#o/tools";
import * as SystemPrompt from "./src/system_prompt.ts";

export const layer = (pi: ExtensionAPI) => {
  const platform = NodeServices.layer;
  const configuration = pipe(
    Layer.merge(Config.layer, StratumConfig.layer),
    Layer.provide(platform),
  );
  const bridge = pipe(
    Bridge.layer,
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
  );
  const foundation = Layer.mergeAll(
    platform,
    configuration,
    Prelude.layer,
    bridge,
    Mcp.Capture.layer(pi),
  );

  const capabilities = pipe(
    Layer.mergeAll(Syntax.layer, Jupyter.layer, CellOutput.layer, Search.Fff.layer),
    Layer.provide(foundation),
  );
  const search = pipe(
    Search.SearchService.layer,
    Layer.provide(Layer.merge(foundation, capabilities)),
  );
  const notebookApis = pipe(
    Layer.mergeAll(
      PiTools.layer,
      PiTools.Prelude.layer,
      Mcp.layer,
      Mcp.Prelude.layer,
      Syntax.Prelude.layer,
    ),
    Layer.provide(Layer.mergeAll(foundation, capabilities, search)),
  );

  const shellResources = pipe(
    Layer.merge(StratumShell.Store.layer, StratumShell.Tmux.layer),
    Layer.provide(foundation),
  );
  const shellService = pipe(
    StratumShell.serviceLayer,
    Layer.provide(Layer.merge(foundation, shellResources)),
  );
  const shellApis = pipe(
    Layer.merge(Shell.layer, Shell.Prelude.layer),
    Layer.provide(Layer.mergeAll(foundation, shellResources, shellService)),
  );
  const enabledShell = Layer.mergeAll(shellResources, shellService, shellApis);
  const shell = pipe(
    Layer.unwrap(
      pipe(
        StratumConfig.Service,
        Effect.map((config) => (config.shell.enabled ? enabledShell : Layer.empty)),
      ),
    ),
    Layer.provide(foundation),
  );

  const runtime = Layer.mergeAll(foundation, capabilities, search, notebookApis, shell);

  const notebook = pipe(Notebook.layer, Layer.provide(runtime));
  const host = Layer.mergeAll(Pi.Host.layer(pi), Pi.Contributions.layer, Pi.Hooks.layer);
  const dependencies = Layer.mergeAll(runtime, notebook, host);
  const features = pipe(
    Layer.mergeAll(
      Session.layer,
      Search.Autocomplete.layer,
      Search.Commands.layer,
      SystemPrompt.layer,
    ),
    Layer.provide(dependencies),
  );
  const services = Layer.merge(dependencies, features);
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
