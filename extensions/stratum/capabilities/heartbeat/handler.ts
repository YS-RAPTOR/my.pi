import { Effect } from "effect";
import { Owner } from "#s/common/owner";
import { Session } from "#s/common/session";
import { Rpcs } from "./rpc.ts";
import { Service } from "./service.ts";
import { Get, Start, Stop } from "./types.ts";

const currentOwner = Session.Current.pipe(
  Effect.map(({ id }) => Owner.make(`session:${id.value}`)),
);

export const handlers = Rpcs.toLayer(
  Service.pipe(
    Effect.map((heartbeat) =>
      Rpcs.of({
        "Heartbeat.Start": (request) =>
          currentOwner.pipe(
            Effect.flatMap((owner) =>
              heartbeat.start(new Start({ ...request, owner })),
            ),
          ),
        "Heartbeat.Get": () =>
          currentOwner.pipe(
            Effect.flatMap((owner) => heartbeat.get(new Get({ owner }))),
          ),
        "Heartbeat.Stop": () =>
          currentOwner.pipe(
            Effect.flatMap((owner) => heartbeat.stop(new Stop({ owner }))),
          ),
      }),
    ),
  ),
);
