import type { Component, ViewportTUI } from "@earendil-works/pi-tui";
import {
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  PubSub,
  Ref,
  Scope,
  Stream,
  pipe,
} from "effect";
import { Heartbeat } from "#s/features/heartbeat";
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
    const heartbeat = yield* Heartbeat.Service;
    const shell = yield* Shell.Service;
    const scope = yield* Scope.Scope;
    const active = yield* Ref.make<Option.Option<Active>>(Option.none());
    const refreshes = yield* PubSub.sliding<void>(1);
    const warned = yield* Ref.make(false);

    const requestRefresh = PubSub.publish(refreshes, undefined).pipe(
      Effect.asVoid,
    );
    const refreshSidebar = Effect.gen(function* () {
      const current = yield* Ref.get(active);
      if (Option.isNone(current)) return;
      const latest = yield* Effect.all({
        heartbeat: heartbeat.get,
        shells: shell.list(true),
      });
      yield* Effect.sync(() => {
        current.value.sidebar.updateHeartbeat(latest.heartbeat);
        current.value.sidebar.updateShells(latest.shells);
        current.value.tui.requestRender();
      });
    }).pipe(Effect.withSpan("Frame.refreshSidebar"));

    yield* pipe(
      Stream.fromPubSub(refreshes),
      Stream.runForEach(() => refreshSidebar),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    yield* Effect.addFinalizer(() => PubSub.shutdown(refreshes));

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
      const initial = yield* Effect.all({
        heartbeat: heartbeat.get,
        shells: shell.list(true),
      });
      yield* Effect.sync(() => {
        sidebar.updateHeartbeat(initial.heartbeat);
        sidebar.updateShells(initial.shells);
      });
      const frameRoot = createRoot(result.slots, theme, { sidebar });
      const cleanupRoot = createRoot(result.slots, theme);
      const polling = yield* pipe(
        Effect.sleep("30 seconds"),
        Effect.andThen(requestRefresh),
        Effect.forever,
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

    yield* notifications.listen(["tool_execution_end"], ({ toolName }) =>
      toolName.startsWith("shell_") || toolName.startsWith("heartbeat_")
        ? requestRefresh
        : Effect.void,
    );
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
