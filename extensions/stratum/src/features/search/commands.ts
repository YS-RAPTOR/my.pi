import { Effect, Layer } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import * as Search from "./service.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const search = yield* Search.Service;
    const contributions = yield* Pi.Contributions.Service;

    yield* contributions.command("search-health", {
      description: "Show indexed search health",
      handler: Effect.fn("Features.Search.Commands.health")(function* (args, context) {
        const callback = yield* Pi.Host.Callback;
        if (args.trim() !== "") {
          yield* callback.ui.notify("Usage: /search-health", "warning");
          return;
        }
        yield* search.initialize(context.cwd);
        const health = yield* search.health;
        yield* callback.ui.notify(
          [
            `Search engine: FFF v${health.version}`,
            `Git: ${health.git.repositoryFound ? "yes" : "no"}`,
            `Files: ${health.filePicker.indexedFiles ?? 0}`,
            `Scanning: ${health.filePicker.isScanning ? "yes" : "no"}`,
            `Frecency: ${health.frecency.initialized ? "active" : "disabled"}`,
          ].join("\n"),
          "info",
        );
      }),
    });

    yield* contributions.command("search-rescan", {
      description: "Rescan the current workspace search index",
      handler: Effect.fn("Features.Search.Commands.rescan")(function* (args, context) {
        const callback = yield* Pi.Host.Callback;
        if (args.trim() !== "") {
          yield* callback.ui.notify("Usage: /search-rescan", "warning");
          return;
        }
        yield* search.initialize(context.cwd);
        yield* search.rescan;
        yield* callback.ui.notify("Search rescan triggered.", "info");
      }),
    });
  }),
);

export * as Commands from "./commands.ts";
