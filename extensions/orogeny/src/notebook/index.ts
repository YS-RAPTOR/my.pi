import { Layer } from "effect";
import { Journal } from "#o/notebook/journal";
import { Runtime } from "#o/notebook/runtime";

export const layer = (config: Runtime.Config) =>
  Runtime.layer(config).pipe(Layer.provide(Journal.layer));

export { Journal, Runtime };
export { Model } from "#o/notebook/model";
export * as Notebook from "./index.ts";
