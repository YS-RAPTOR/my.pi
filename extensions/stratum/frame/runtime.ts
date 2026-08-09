import type { Component, ViewportTUI } from "@earendil-works/pi-tui";
import {
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schedule,
  Scope,
  Stream,
  pipe,
} from "effect";
import { Shell } from "#s/features/shell";
import { Pi } from "#s/pi";
import { Footer } from "./footer/index.ts";
import { createRoot } from "./layout.ts";
import { probeFrameLayout } from "./probe.ts";
import { Sidebar } from "./sidebar/index.ts";

type Active = Readonly<{
  tui: ViewportTUI;
  cleanupRoot: Component;
  sidebar: Sidebar;
  stopPolling: Effect.Effect<void>;
}>;

const runtime = Layer.effectDiscard(
  Effect.gen(function* () {
    const barriers = yield* Pi.Hooks.Barriers.Service;
    const notifications = yield* Pi.Hooks.Notifications.Service;
    const footer = yield* Footer.Service;
    const shell = yield* Shell.Service;
    const scope = yield* Scope.Scope;
    const active = yield* Ref.make<Option.Option<Active>>(Option.none());
    const warned = yield* Ref.make(false);

    const restore = Effect.fn("Frame.__restore")(function* (current: Active) {
      yield* current.stopPolling;
      yield* footer.shutdown;
      yield* Effect.sync(() => current.tui.setLayoutRoot(current.cleanupRoot));
    });

    const shutdown = Effect.gen(function* () {
      const current = yield* Ref.getAndSet(active, Option.none());
      if (Option.isNone(current)) yield* footer.shutdown;
      else yield* restore(current.value);
    }).pipe(Effect.withSpan("Frame.shutdown"));

    const activate = Effect.gen(function* () {
      const callback = yield* Pi.Host.Callback;
      if ((yield* callback.session.mode) !== "tui") return;

      const result = yield* probeFrameLayout(callback.ui);
      if (Predicate.isTagged(result, "invalid")) {
        const notify = yield* Ref.modify(warned, (shown) => [!shown, true]);
        if (notify) {
          yield* callback.ui.notify(
            `Frame left Pi's layout unchanged: ${result.reason}.`,
            "warning",
          );
        }
        return;
      }
      if (!Predicate.isTagged(result, "valid")) return;

      const theme = yield* callback.ui.theme;
      const thinkingLevel = yield* callback.agent.thinkingLevel;
      const sidebar = new Sidebar(
        theme,
        () => result.tui.terminal.rows,
        thinkingLevel,
      );
      const frameRoot = createRoot(result.slots, theme, { sidebar });
      const cleanupRoot = createRoot(result.slots, theme);
      const polling = yield* pipe(
        Stream.fromEffectSchedule(
          shell.list(true),
          Schedule.spaced("30 seconds"),
        ),
        Stream.runForEach((resources) =>
          Effect.sync(() => {
            sidebar.updateShells(resources);
            result.tui.requestRender();
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      const next: Active = {
        tui: result.tui,
        cleanupRoot,
        sidebar,
        stopPolling: Fiber.interrupt(polling).pipe(Effect.asVoid),
      };
      yield* Effect.gen(function* () {
        yield* footer.install;
        yield* Effect.sync(() => result.tui.setLayoutRoot(frameRoot));
        yield* Ref.set(active, Option.some(next));
      }).pipe(Effect.onError(() => restore(next)));
    }).pipe(Effect.withSpan("Frame.activate"));

    yield* notifications.listen(["tool_execution_end"], ({ toolName }) => {
      if (!toolName.startsWith("shell_")) return Effect.void;
      return Effect.gen(function* () {
        const current = yield* Ref.get(active);
        if (Option.isNone(current)) return;
        const resources = yield* shell.list(true);
        yield* Effect.sync(() => {
          current.value.sidebar.updateShells(resources);
          current.value.tui.requestRender();
        });
      });
    });
    yield* notifications.listen(["thinking_level_select"], ({ level }) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(active);
        if (Option.isNone(current)) return;
        yield* Effect.sync(() => {
          current.value.sidebar.setThinkingLevel(level);
          current.value.tui.requestRender();
        });
      }),
    );
    yield* barriers.handle("session_start", () => activate);
    yield* barriers.handle("session_shutdown", () => shutdown);
    yield* Effect.addFinalizer(() => shutdown);
  }),
);

export const layer = pipe(runtime, Layer.provide(Footer.layer));
