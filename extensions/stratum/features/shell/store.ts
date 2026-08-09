import { Context, Data, Effect, Layer, Option, Predicate } from "effect";
import { Herdr } from "./herdr/index.ts";
import { Stdio } from "./stdio/index.ts";
import { ResourceId } from "./types.ts";

export type Entry = Data.TaggedEnum<{
  stdio: {
    id: ResourceId;
    resource: Stdio.Resource;
  };
  terminal: {
    id: ResourceId;
    resource: Herdr.Resource;
    identity?: string;
  };
}>;

export type NewEntry = Data.TaggedEnum<{
  stdio: {
    resource: Stdio.Resource;
  };
  terminal: {
    resource: Herdr.Resource;
    identity?: string;
  };
}>;

export const NewEntry = Data.taggedEnum<NewEntry>();

export type Interface = Readonly<{
  register: (entry: NewEntry) => Effect.Effect<Entry>;
  get: (id: ResourceId) => Effect.Effect<Option.Option<Entry>>;
  entries: Effect.Effect<ReadonlyArray<Entry>>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Shell.Store",
) {}

export const layer = Layer.sync(Service)(() => {
  let nextResource = 1;
  const resources = new Map<string, Entry>();

  const register: Interface["register"] = Effect.fn("Shell.Store.register")(
    (entry) =>
      Effect.sync(() => {
        if (Predicate.isTagged(entry, "terminal") && entry.identity !== undefined) {
          const existing = Array.from(resources.values()).find(
            (candidate) =>
              Predicate.isTagged(candidate, "terminal") &&
              candidate.identity === entry.identity,
          );
          if (existing !== undefined) return existing;
        }

        const driver = Predicate.isTagged(entry, "stdio")
          ? "stdio"
          : entry.resource.driver;
        const id = new ResourceId({
          value: `shell:${driver}:${nextResource++}`,
        });
        const registered = { ...entry, id } as Entry;
        resources.set(id.value, registered);
        return registered;
      }),
  );

  const get: Interface["get"] = Effect.fn("Shell.Store.get")((id) =>
    Effect.sync(() => Option.fromUndefinedOr(resources.get(id.value))),
  );

  const entries: Interface["entries"] = Effect.sync(() =>
    Array.from(resources.values()),
  ).pipe(Effect.withSpan("Shell.Store.entries"));

  return Service.of({ register, get, entries });
});

export * as Store from "./store.ts";
