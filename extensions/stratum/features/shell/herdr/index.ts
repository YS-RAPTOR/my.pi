import { Context, Effect, Layer, Option, pipe, Schema } from "effect";
import type { Open, PtyUnavailable } from "../types.ts";
import { Private } from "./private.ts";
import { Repo } from "./repo.ts";
import { Terminal } from "./terminal.ts";

export type Resource = Terminal.Resource;

export type Discovered = Readonly<{
  identity: string;
  resource: Resource;
}>;

export type Interface = Readonly<{
  open: (command: Open) => Effect.Effect<Resource, PtyUnavailable>;
  discover: Effect.Effect<ReadonlyArray<Discovered>>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Shell.Herdr",
) {}

export const layer = pipe(
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const privateHerdr = yield* Private.Service;
      const repo = yield* Repo.Service;
      const terminal = yield* Terminal.Service;
      const userSocketPath = pipe(
        Schema.decodeUnknownOption(Schema.NonEmptyString)(
          process.env.HERDR_SOCKET_PATH,
        ),
        Option.getOrUndefined,
      );

      const open: Interface["open"] = Effect.fn("Shell.Herdr.open")(
        function* (command) {
          const opened = yield* privateHerdr.open(command);
          return yield* terminal.create({
            driver: "pty",
            socketPath: opened.socketPath,
            pane: opened.pane,
            launch: opened.launch,
            cmd: command.cmd,
            cwd: command.cwd,
          });
        },
      );

      const discover: Interface["discover"] = Effect.gen(function* () {
        if (userSocketPath === undefined) return [];
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
            terminal.create({
              driver: "herdr",
              socketPath: userSocketPath,
              pane,
              cmd: pane.title ?? pane.terminal_title_stripped ?? "",
              cwd: pane.foreground_cwd ?? pane.cwd ?? "/",
              workspace: workspaces.get(pane.workspace_id) ?? pane.workspace_id,
            }),
            Effect.map((resource) => ({
              identity: `${userSocketPath}\u0000${pane.terminal_id}`,
              resource,
            })),
          ),
        );
      }).pipe(Effect.withSpan("Shell.Herdr.discover"));

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
