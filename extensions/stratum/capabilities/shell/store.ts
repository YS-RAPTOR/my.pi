import type { Data } from "effect";
import {
  Context,
  Effect,
  HashMap,
  Layer,
  Match,
  Option,
  pipe,
  Predicate,
  Ref,
} from "effect";
import { Herdr } from "./herdr/index.ts";
import { Stdio } from "./stdio/index.ts";
import type { Driver } from "./types.ts";
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

type State = Readonly<{
  nextResource: Readonly<Record<typeof Driver.Encoded, number>>;
  resources: HashMap.HashMap<string, Entry>;
}>;

export type Interface = Readonly<{
  register: (
    entry: Data.TaggedEnum<{
      stdio: Omit<Data.TaggedEnum.Value<Entry, "stdio">, "_tag" | "id">;
      terminal: Omit<Data.TaggedEnum.Value<Entry, "terminal">, "_tag" | "id">;
    }>,
  ) => Effect.Effect<Entry>;
  get: (id: ResourceId) => Effect.Effect<Option.Option<Entry>>;
  entries: Effect.Effect<ReadonlyArray<Entry>>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Shell.Store",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({
      nextResource: { stdio: 1, pty: 1, herdr: 1 },
      resources: HashMap.empty(),
    });

    const register: Interface["register"] = Effect.fn("Shell.Store.register")(
      (entry) =>
        Ref.modify(state, (current) => {
          const existing = pipe(
            Match.value(entry),
            Match.tagsExhaustive({
              stdio: () => Option.none(),
              terminal: (terminal) =>
                pipe(
                  current.resources,
                  HashMap.findFirst(
                    (candidate) =>
                      terminal.identity !== undefined &&
                      Predicate.isTagged(candidate, "terminal") &&
                      candidate.identity === terminal.identity,
                  ),
                  Option.map(([, candidate]) => candidate),
                ),
            }),
          );
          if (Option.isSome(existing)) return [existing.value, current];

          const driver = pipe(
            Match.value(entry),
            Match.tagsExhaustive({
              stdio: () => "stdio" as const,
              terminal: (terminal) => terminal.resource.driver,
            }),
          );
          const id = new ResourceId({
            value: `shell:${driver}:${current.nextResource[driver]}`,
          });
          const registered = { ...entry, id };
          return [
            registered,
            {
              ...current,
              nextResource: {
                ...current.nextResource,
                [driver]: current.nextResource[driver] + 1,
              },
              resources: HashMap.set(current.resources, id.value, registered),
            },
          ];
        }),
    );

    const get: Interface["get"] = Effect.fn("Shell.Store.get")(function* (id) {
      const current = yield* Ref.get(state);
      return HashMap.get(current.resources, id.value);
    });

    const entries: Interface["entries"] = Effect.map(
      Ref.get(state),
      (current) => Array.from(HashMap.values(current.resources)),
    );

    return Service.of({
      register,
      get,
      entries,
    });
  }),
);

export * as Store from "./store.ts";
