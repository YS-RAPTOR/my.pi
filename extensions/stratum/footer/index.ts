import { Effect, Layer, pipe } from "effect";
import { Pi } from "#s/pi";
import { FooterComponent } from "./component.ts";
import { Runway } from "./runway/index.ts";

const runtime = Layer.effectDiscard(
  Effect.gen(function* () {
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
            requestRender,
          );
        });
        yield* runway.enable(context, () => requestRender());
      }),
    );
  }),
);

export const layer = pipe(runtime, Layer.provide(Runway.layer));

export * as Footer from "./index.ts";
