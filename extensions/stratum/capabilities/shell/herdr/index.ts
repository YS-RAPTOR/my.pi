import { Context, Effect, Layer, pipe } from "effect";
import { Session } from "#s/common/session";
import type { Open } from "../types.ts";
import type { PtyUnavailable } from "../types.ts";
import { Private } from "./private.ts";
import { Repo } from "./repo.ts";
import { Terminal } from "./terminal.ts";

export type Resource = Terminal.Resource;

export type Discovered = Readonly<{
  identity: string;
  resource: Resource;
}>;

export type Interface = Readonly<{
  open: (
    owner: Session.ID,
    command: Open,
  ) => Effect.Effect<Resource, PtyUnavailable>;
  discover: (owner: Session.ID) => Effect.Effect<ReadonlyArray<Discovered>>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Shell.Herdr",
) {}

export const layer = pipe(
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const privateHerdr = yield* Private.Service;
      const repo = yield* Repo.Service;
      const terminal = yield* Terminal.Service;
      const userSocketPath = process.env.HERDR_SOCKET_PATH;

      const open: Interface["open"] = Effect.fn("Shell.Herdr.open")(
        function* (owner, command) {
          const opened = yield* privateHerdr.open(command);
          return yield* terminal.create(owner, {
            driver: "pty",
            socketPath: opened.socketPath,
            pane: opened.pane,
            launch: opened.launch,
            cmd: command.cmd,
            cwd: command.cwd,
          });
        },
      );

      const discover: Interface["discover"] = Effect.fn("Shell.Herdr.discover")(
        function* (owner) {
          if (userSocketPath === undefined || userSocketPath.length === 0)
            return [];
          const snapshot = yield* pipe(
            repo.session(userSocketPath),
            Effect.orElseSucceed(() => undefined),
          );
          if (snapshot === undefined) return [];

          const workspaces = new Map(
            snapshot.workspaces.map((workspace) => [
              workspace.workspace_id,
              workspace.label,
            ]),
          );
          return yield* Effect.forEach(snapshot.panes, (pane) =>
            pipe(
              terminal.create(owner, {
                driver: "herdr",
                socketPath: userSocketPath,
                pane,
                cmd: pane.title ?? pane.terminal_title_stripped ?? "",
                cwd: pane.foreground_cwd ?? pane.cwd ?? "/",
                workspace:
                  workspaces.get(pane.workspace_id) ?? pane.workspace_id,
              }),
              Effect.map((resource) => ({
                identity: `${userSocketPath}\u0000${pane.terminal_id}`,
                resource,
              })),
            ),
          );
        },
      );

      return Service.of({ open, discover });
    }),
  ),
  Layer.provide(Private.layer),
  Layer.provide(Terminal.layer),
  Layer.provide(Repo.layer),
);

export { Private } from "./private.ts";
export { Repo } from "./repo.ts";
export { Terminal } from "./terminal.ts";
export * as Herdr from "./index.ts";
