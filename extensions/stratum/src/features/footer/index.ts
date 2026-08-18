import { Effect, Layer, pipe } from "effect";
import { Config } from "#s/config";
import { Pi } from "@ys-raptor/pi-effect";
import { FooterComponent } from "./component.ts";
import { Runway } from "./runway/index.ts";

const runtime = Layer.effectDiscard(
  Effect.gen(function* () {
    const { footer: config } = yield* Config.Service;
    const barriers = yield* Pi.Hooks.Barriers.Service;
    const runway = yield* Runway.Service;

    yield* barriers.handle(
      "session_start",
      Effect.fn("Footer.install")(function* () {
        const callback = yield* Pi.Host.Callback;
        const context = yield* Pi.Host.CallbackContext;
        let requestRender = () => {};

        yield* callback.ui.setFooter((tui, theme, footerData) => {
          requestRender = () => tui.requestRender();
          return new FooterComponent(
            context,
            theme,
            footerData,
            runway,
            config,
            requestRender,
          );
        });
        yield* runway.enable(context, () => requestRender());
      }),
    );
  }),
);

const configuredLayer = pipe(
  Effect.map(Config.Service, ({ footer }) =>
    pipe(
      runtime,
      Layer.provide(
        footer.runway.enabled ? Runway.layer : Runway.disabledLayer,
      ),
    ),
  ),
  Layer.unwrap,
);

export const layer = pipe(
  Effect.map(Config.Service, ({ footer }) =>
    footer.enabled ? configuredLayer : Layer.empty,
  ),
  Layer.unwrap,
);

export * as Footer from "./index.ts";
