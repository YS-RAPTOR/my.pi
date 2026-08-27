import { Effect, Layer } from "effect";
import { Config } from "#s/config";
import { Pi } from "@ys-raptor/pi-effect";
import { FooterComponent } from "./component.ts";
import { Runway } from "./runway/index.ts";

export const layer = Layer.effectDiscard(
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
          return new FooterComponent(context, theme, footerData, runway, config, requestRender);
        });
        yield* runway.enable(context, () => requestRender());
      }),
    );
  }),
);

export { Runway } from "./runway/index.ts";

export * as Footer from "./index.ts";
