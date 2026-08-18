import { Layer } from "effect";
import { Connection } from "#o/jupyter/connection";
import { Kernel } from "#o/jupyter/kernel";
import { Transport } from "#o/jupyter/transport";

const dependencyLayer = Layer.merge(Connection.layer, Transport.layer);

export const layer = Kernel.layer.pipe(Layer.provide(dependencyLayer));

export { Codec } from "#o/jupyter/codec";
export { Connection, Kernel, Transport };
export * as Jupyter from "./index.ts";
