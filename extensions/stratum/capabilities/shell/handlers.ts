import { Effect } from "effect";
import { Session } from "#s/common/session";
import { Rpcs } from "./rpcs.ts";
import { Service } from "./service.ts";

const withSession =
  <Request, Success, Error, Requirements>(
    operation: (
      session: Session.ID,
      request: Request,
    ) => Effect.Effect<Success, Error, Requirements>,
  ) =>
  (request: Request) =>
    Effect.flatMap(Session.Current, ({ id }) => operation(id, request));

export const handlers = Rpcs.toLayer(
  Service.pipe(
    Effect.map((shell) =>
      Rpcs.of({
        "Shell.Open": withSession(shell.open),
        "Shell.Snapshot": withSession(shell.snapshot),
        "Shell.List": withSession(shell.list),
        "Shell.Inspect": withSession(shell.inspect),
        "Shell.Write": withSession(shell.write),
        "Shell.CloseStdin": withSession(shell.closeStdin),
        "Shell.Signal": withSession(shell.signal),
      }),
    ),
  ),
);
