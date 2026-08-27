import { Effect, Layer, pipe } from "effect";
import { Config } from "#s/config";
import { Autocomplete } from "./autocomplete.ts";
import { Commands } from "./commands.ts";
import { Fff } from "./fff.ts";
import { SearchService } from "./service.ts";

const services = pipe(SearchService.layer, Layer.provide(Fff.layer));

const runtime = Layer.mergeAll(
  services,
  pipe(Autocomplete.layer, Layer.provide(services)),
  pipe(Commands.layer, Layer.provide(services)),
);

export const layer = pipe(
  Effect.map(Config.Service, ({ search }) => (search.enabled ? runtime : Layer.empty)),
  Layer.unwrap,
);

export { Autocomplete } from "./autocomplete.ts";
export { Commands } from "./commands.ts";
export { Fff } from "./fff.ts";
export * from "./query.ts";
export { FindInput, FindOutput, GrepInput, GrepOutput, SearchFailed, Service } from "./service.ts";
export type { Interface, SearchError } from "./service.ts";
export * as Search from "./index.ts";
