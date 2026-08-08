import { Effect } from "effect";
import { Owner } from "#s/common/owner";
import { Session } from "#s/common/session";
import { Rpcs } from "./rpc.ts";
import { Service } from "./service.ts";
import { Activate, Release, ReleaseOwner } from "./types.ts";

const currentOwner = Session.Current.pipe(
  Effect.map(({ id }) => Owner.make(`session:${id.value}`)),
);

export const handlers = Rpcs.toLayer(
  Service.pipe(
    Effect.map((activity) =>
      Rpcs.of({
        "Activity.Activate": (request) =>
          currentOwner.pipe(
            Effect.flatMap((owner) =>
              activity.activate(new Activate({ ...request, owner })),
            ),
          ),
        "Activity.Release": (request) =>
          currentOwner.pipe(
            Effect.flatMap((owner) =>
              activity.release(new Release({ ...request, owner })),
            ),
          ),
        "Activity.ReleaseOwner": () =>
          currentOwner.pipe(
            Effect.flatMap((owner) =>
              activity.releaseOwner(new ReleaseOwner({ owner })),
            ),
          ),
        "Activity.Snapshot": () =>
          currentOwner.pipe(Effect.flatMap(activity.snapshot)),
      }),
    ),
  ),
);
