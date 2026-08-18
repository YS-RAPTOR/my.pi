import { Effect, Layer, pipe } from "effect";
import { Config } from "#s/config";
import { layer as serviceLayer } from "./service.ts";
import { Store } from "./store.ts";
import { Tmux } from "./tmux.ts";

const dependencies = Layer.merge(Store.layer, Tmux.layer);
const configuredLayer = pipe(serviceLayer, Layer.provide(dependencies));

export const layer = pipe(
  Effect.map(Config.Service, ({ shell }) =>
    shell.enabled ? configuredLayer : Layer.empty,
  ),
  Layer.unwrap,
);

export {
  Continuation,
  type Interface,
  ListInput,
  OpenInput,
  OpenResult,
  OperationFailed,
  ReadInput,
  ReadResult,
  Service,
  type ShellError,
} from "./service.ts";
export { Inspection, ResourceNotFound, Store } from "./store.ts";
export { Tmux } from "./tmux.ts";
export * as Shell from "./index.ts";
