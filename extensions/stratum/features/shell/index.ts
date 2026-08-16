import { Layer, pipe } from "effect";
import { layer as serviceLayer } from "./service.ts";
import { Store } from "./store.ts";
import { Tmux } from "./tmux.ts";

const dependencies = Layer.merge(Store.layer, Tmux.layer);

export const layer = pipe(serviceLayer, Layer.provide(dependencies));

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
