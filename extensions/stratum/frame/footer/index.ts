import { Context, Effect, Layer, MutableRef, Option, pipe } from "effect";
import { Pi } from "#s/pi";
import { FrameFooter, type View } from "./component.ts";
import { Runway } from "./runway/index.ts";

type State = Readonly<{
  view: Option.Option<View>;
  uninstall: Effect.Effect<void>;
  requestRender: Option.Option<() => void>;
}>;

export type Interface = Readonly<{
  install: Effect.Effect<void, never, Pi.Host.Callback>;
  shutdown: Effect.Effect<void>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Frame.Footer",
) {}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const notifications = yield* Pi.Hooks.Notifications.Service;
    const runway = yield* Runway.Service;
    const state = MutableRef.make<State>({
      view: Option.none(),
      uninstall: Effect.void,
      requestRender: Option.none(),
    });

    const capture = Effect.gen(function* () {
      const callback = yield* Pi.Host.Callback;
      const view = yield* Effect.all({
        sessionManager: callback.session.sessionManager,
        modelRegistry: callback.agent.modelRegistry,
        model: callback.agent.model,
        thinkingLevel: callback.agent.thinkingLevel,
        contextUsage: callback.session.getContextUsage,
      });
      return { callback, view } as const;
    });

    const redraw = Effect.sync(() => {
      if (Option.isSome(state.current.requestRender)) {
        state.current.requestRender.value();
      }
    });

    const refresh = Effect.gen(function* () {
      const { view } = yield* capture;
      state.current = { ...state.current, view: Option.some(view) };
      yield* runway.update(view);
      yield* redraw;
    }).pipe(Effect.withSpan("Frame.Footer.refresh"));

    const install: Interface["install"] = Effect.gen(function* () {
      const { callback, view } = yield* capture;
      state.current = { ...state.current, view: Option.some(view) };
      yield* runway.update(view);
      yield* callback.ui.setFooter((tui, theme, footerData) => {
        const requestRender = () => tui.requestRender();
        state.current = {
          ...state.current,
          requestRender: Option.some(requestRender),
        };
        return new FrameFooter(
          () => Option.getOrElse(state.current.view, () => view),
          theme,
          footerData,
          runway,
          requestRender,
        );
      });
      state.current = {
        ...state.current,
        uninstall: callback.ui.setFooter(undefined),
      };
      if (Option.isSome(state.current.requestRender)) {
        yield* runway.enable(state.current.requestRender.value);
      }
    }).pipe(Effect.withSpan("Frame.Footer.install"));

    const shutdown: Interface["shutdown"] = Effect.gen(function* () {
      yield* runway.disable;
      const uninstall = state.current.uninstall;
      state.current = {
        view: Option.none(),
        uninstall: Effect.void,
        requestRender: Option.none(),
      };
      yield* uninstall;
    }).pipe(Effect.withSpan("Frame.Footer.shutdown"));

    yield* notifications.listen(
      [
        "session_info_changed",
        "session_compact",
        "session_tree",
        "turn_end",
        "model_select",
        "thinking_level_select",
      ],
      () => refresh,
    );
    yield* Effect.addFinalizer(() => shutdown);

    return Service.of({ install, shutdown });
  }),
);

export const layer = pipe(serviceLayer, Layer.provide(Runway.layer));

export * as Footer from "./index.ts";
