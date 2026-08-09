import { Layer, pipe } from "effect";
import { Herdr } from "./herdr/index.ts";
import { layer as serviceLayer } from "./service.ts";
import { Stdio } from "./stdio/index.ts";
import { Store } from "./store.ts";
import { Tools } from "./tools/index.ts";

const backend = pipe(
  serviceLayer,
  Layer.provide(Herdr.layer),
  Layer.provide(Stdio.layer),
  Layer.provide(Store.layer),
);

export const layer = Layer.merge(
  backend,
  pipe(Tools.layer, Layer.provide(backend)),
);

export { type Interface, Service } from "./service.ts";
export * from "./types.ts";
export { Herdr } from "./herdr/index.ts";
export { Stdio } from "./stdio/index.ts";
export { Store } from "./store.ts";
export { Tools } from "./tools/index.ts";
export * as Shell from "./index.ts";
