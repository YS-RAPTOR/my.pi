import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
  pipe,
} from "effect";
import { Owner } from "#s/common/owner";
import {
  Activate,
  Changed,
  Claim,
  ID,
  Release,
  ReleaseOwner,
  Snapshot,
} from "./types.ts";

type State = ReadonlyMap<string, Claim>;

export type Interface = Readonly<{
  activate: (request: Activate) => Effect.Effect<Claim>;
  release: (request: Release) => Effect.Effect<void>;
  releaseOwner: (request: ReleaseOwner) => Effect.Effect<void>;
  snapshot: (owner?: Owner) => Effect.Effect<Snapshot>;
  watch: (owner?: Owner) => Stream.Stream<Changed>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Activity",
) {}

const keyOf = (owner: Owner, id: ID) => `${owner}\u0000${id}`;

const snapshotOf = (state: State, owner?: Owner) =>
  new Snapshot({
    claims: [...state.values()]
      .filter((claim) => owner === undefined || claim.owner === owner)
      .sort(
        (left, right) =>
          left.owner.localeCompare(right.owner) ||
          left.id.localeCompare(right.id),
      ),
  });

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<State>(new Map());

    const activate: Interface["activate"] = Effect.fn("Activity.activate")(
      function* (request) {
        const now = yield* Clock.currentTimeMillis;
        return yield* SubscriptionRef.modifySome(state, (current) => {
          const key = keyOf(request.owner, request.id);
          const existing = current.get(key);
          if (existing !== undefined && existing.reason === request.reason) {
            return [existing, Option.none()];
          }
          const claim = new Claim({
            ...request,
            started_at: existing?.started_at ?? now,
          });
          const updated = new Map(current);
          updated.set(key, claim);
          return [claim, Option.some(updated)];
        });
      },
    );

    const release: Interface["release"] = Effect.fn("Activity.release")(
      function* (request) {
        yield* SubscriptionRef.modifySome(state, (current) => {
          const key = keyOf(request.owner, request.id);
          if (!current.has(key)) return [undefined, Option.none()];
          const updated = new Map(current);
          updated.delete(key);
          return [undefined, Option.some(updated)];
        });
      },
    );

    const releaseOwner: Interface["releaseOwner"] = Effect.fn(
      "Activity.releaseOwner",
    )(function* (request) {
      yield* SubscriptionRef.modifySome(state, (current) => {
        const updated = new Map(current);
        for (const [key, claim] of updated) {
          if (claim.owner === request.owner) updated.delete(key);
        }
        return updated.size === current.size
          ? [undefined, Option.none()]
          : [undefined, Option.some(updated)];
      });
    });

    const snapshot: Interface["snapshot"] = Effect.fn("Activity.snapshot")(
      function* (owner) {
        return snapshotOf(yield* SubscriptionRef.get(state), owner);
      },
    );

    const watch: Interface["watch"] = (owner) =>
      pipe(
        SubscriptionRef.changes(state),
        Stream.map((current) => snapshotOf(current, owner)),
        Stream.changes,
        Stream.map((snapshot) => new Changed({ snapshot })),
      );

    return Service.of({ activate, release, releaseOwner, snapshot, watch });
  }),
);
