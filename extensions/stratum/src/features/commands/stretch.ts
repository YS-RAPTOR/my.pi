import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Ref, Semaphore, pipe } from "effect";
import { Config } from "#s/config";
import { Pi } from "@ys-raptor/pi-effect";

type Model = NonNullable<ExtensionCommandContext["model"]>;

type ActiveStretch = Readonly<{
  model: Model;
  base: number;
  effective: number;
}>;

const formatTokens = (tokens: number): string => `${tokens.toLocaleString("en-US")} tokens`;

const runtime = Layer.effectDiscard(
  Effect.gen(function* () {
    const { stretch: config } = (yield* Config.Service).commands;
    const contributions = yield* Pi.Contributions.Service;
    const barriers = yield* Pi.Hooks.Barriers.Service;
    const notifications = yield* Pi.Hooks.Notifications.Service;
    const active = yield* Ref.make<ActiveStretch | null>(null);
    const mutex = yield* Semaphore.make(1);

    const restore = Effect.fn("Features.Commands.Stretch.restore")(function* () {
      const current = yield* Ref.getAndSet(active, null);
      if (current !== null && current.model.contextWindow === current.effective) {
        yield* Effect.sync(() => {
          current.model.contextWindow = current.base;
        });
      }
    });

    const reset = () => mutex.withPermit(restore());

    yield* barriers.handle(
      "session_start",
      Effect.fn("Features.Commands.Stretch.sessionStarted")(reset),
    );
    yield* barriers.handle(
      "session_shutdown",
      Effect.fn("Features.Commands.Stretch.sessionEnded")(reset),
    );
    yield* notifications.listen(
      ["session_compact"],
      Effect.fn("Features.Commands.Stretch.sessionCompacted")(reset),
    );
    yield* notifications.listen(
      ["model_select"],
      Effect.fn("Features.Commands.Stretch.modelSelected")(function* (event) {
        yield* mutex.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(active);
            if (current !== null && current.model !== event.model) {
              yield* restore();
            }
          }),
        );
      }),
    );

    yield* contributions.command("stretch", {
      description: "Temporarily increase the current model context window",
      handler: Effect.fn("Features.Commands.Stretch.command")(function* (args) {
        const callback = yield* Pi.Host.Callback;
        if (args.trim() !== "") {
          yield* callback.ui.notify("Usage: /stretch", "warning");
          return;
        }

        yield* mutex.withPermit(
          Effect.gen(function* () {
            const model = yield* callback.agent.model;
            if (model === undefined) {
              yield* callback.ui.notify("/stretch requires an active model.", "warning");
              return;
            }

            let current = yield* Ref.get(active);
            if (current !== null && current.model !== model) {
              yield* restore();
              current = null;
            }

            const base = current?.base ?? model.contextWindow;
            const effective = current?.effective ?? model.contextWindow;
            const maximum = Math.max(base, config["max-context-tokens"]);
            const next = Math.min(effective + config["step-tokens"], maximum);

            if (next <= effective) {
              yield* callback.ui.notify(
                `Context window is already at its maximum: base ${formatTokens(base)}, effective ${formatTokens(effective)}, maximum ${formatTokens(maximum)}.`,
                "info",
              );
              return;
            }

            yield* Effect.sync(() => {
              model.contextWindow = next;
            });
            yield* Ref.set(active, { model, base, effective: next });
            yield* callback.ui.notify(
              `Context window stretched: base ${formatTokens(base)}, effective ${formatTokens(next)}, maximum ${formatTokens(maximum)}.`,
              "info",
            );
          }),
        );
      }),
    });

    yield* Effect.addFinalizer(reset);
  }),
);

export const layer = pipe(
  Effect.map(Config.Service, ({ commands }) =>
    commands.enabled && commands.stretch.enabled ? runtime : Layer.empty,
  ),
  Layer.unwrap,
);

export * as Stretch from "./stretch.ts";
