import { Layer, pipe } from "effect";
import { serviceLayer } from "./service.ts";
import { Tools } from "./tools/index.ts";

export const layer = Layer.merge(
  serviceLayer,
  pipe(Tools.layer, Layer.provide(serviceLayer)),
);

export { type Interface, Service } from "./service.ts";
export * from "./types.ts";
export { Tools } from "./tools/index.ts";
export * as Heartbeat from "./index.ts";
