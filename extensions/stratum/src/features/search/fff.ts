import { FileFinder, type FileFinderApi, type InitOptions, type Result } from "@ff-labs/fff-node";
import { Context, Layer } from "effect";

export type Interface = Readonly<{
  create: (options: InitOptions) => Result<FileFinderApi>;
}>;

export class Service extends Context.Service<Service, Interface>()("stratum/Features.Search.Fff") {}

export const layer = Layer.succeed(Service, Service.of({ create: FileFinder.create }));

export * as Fff from "./fff.ts";
