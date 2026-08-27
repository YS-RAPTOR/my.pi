import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  Context,
  Data,
  Duration,
  Effect,
  FiberMap,
  Layer,
  MutableRef,
  Option,
  Predicate,
  Schedule,
  SynchronizedRef,
  pipe,
} from "effect";
import { Config } from "#s/config";
import type { FooterVariant } from "../parts.ts";
import { renderLoading, renderProblem, renderReport, type RunwayMode } from "./bar.ts";
import {
  isCodexContext,
  queryUsage,
  type Context as RunwayContext,
  type UsageReport,
} from "./usage.ts";

type Problem = "error" | "unavailable";
type Display = Data.TaggedEnum<{
  loading: {};
  report: { report: UsageReport; failedRefreshes: number };
  problem: { problem: Problem };
}>;

const Display = Data.taggedEnum<Display>();

type State = Readonly<{
  context: Option.Option<RunwayContext>;
  display: Display;
  requestRender: Option.Option<() => void>;
}>;

export type Interface = Readonly<{
  enable: (context: RunwayContext, requestRender: () => void) => Effect.Effect<void>;
  variants: (theme: Theme) => ReadonlyArray<FooterVariant>;
  disable: Effect.Effect<void>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Footer.Runway",
) {}

export const disabledLayer = Layer.succeed(
  Service,
  Service.of({
    enable: () => Effect.void,
    variants: () => [],
    disable: Effect.void,
  }),
);

const fixedVariant = (id: string, text: string): FooterVariant => {
  const width = visibleWidth(text);
  return {
    id,
    minWidth: width,
    preferredWidth: width,
    render: () => text,
  };
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = (yield* Config.Service).footer.runway;
    const queries = yield* FiberMap.make<"query">();
    const state = yield* SynchronizedRef.make<State>({
      context: Option.none(),
      display: Display.loading(),
      requestRender: Option.none(),
    });
    const loadingFrame = MutableRef.make(0);

    const redraw = Effect.sync(() => {
      const requestRender = SynchronizedRef.getUnsafe(state).requestRender;
      if (Option.isSome(requestRender)) requestRender.value();
    });

    const refresh = Effect.fn("Footer.Runway.__refresh")(function* () {
      const current = yield* SynchronizedRef.get(state);
      if (
        Option.isNone(current.requestRender) ||
        Option.isNone(current.context) ||
        !isCodexContext(current.context.value)
      ) {
        return;
      }
      const context = current.context.value;

      yield* FiberMap.run(
        queries,
        "query",
        pipe(
          Effect.gen(function* () {
            yield* SynchronizedRef.update(state, (latest) =>
              Predicate.isTagged(latest.display, "problem")
                ? { ...latest, display: Display.loading() }
                : latest,
            );
            return yield* queryUsage(context, config["request-timeout-ms"]);
          }),
          Effect.matchEffect({
            onFailure: (error) =>
              SynchronizedRef.update(state, (latest) => {
                const failedRefreshes = Predicate.isTagged(latest.display, "report")
                  ? latest.display.failedRefreshes + 1
                  : config["cached-failure-limit"];
                return {
                  ...latest,
                  display:
                    Predicate.isTagged(latest.display, "report") &&
                    failedRefreshes < config["cached-failure-limit"]
                      ? Display.report({
                          report: latest.display.report,
                          failedRefreshes,
                        })
                      : Display.problem({
                          problem: Predicate.isTagged(error, "UsageUnavailable")
                            ? "unavailable"
                            : "error",
                        }),
                };
              }),
            onSuccess: (report) =>
              SynchronizedRef.update(state, (latest) => ({
                ...latest,
                display: Display.report({ report, failedRefreshes: 0 }),
              })),
          }),
          Effect.ensuring(redraw),
        ),
        { onlyIfMissing: true },
      );
    });

    const enable: Interface["enable"] = Effect.fn("Footer.Runway.enable")(
      function* (context, requestRender) {
        yield* SynchronizedRef.update(state, (current) => ({
          ...current,
          context: Option.some(context),
          requestRender: Option.some(requestRender),
        }));
        yield* refresh();
        yield* redraw;
      },
    );

    const variants: Interface["variants"] = (theme) => {
      const current = SynchronizedRef.getUnsafe(state);
      if (Option.isNone(current.context) || !isCodexContext(current.context.value)) {
        return [];
      }
      const loading = Predicate.isTagged(current.display, "loading");
      const frame = loadingFrame.current;
      if (loading) loadingFrame.current += 1;
      const now = Date.now();
      const renderMode = (mode: RunwayMode): string => {
        if (Predicate.isTagged(current.display, "report")) {
          return renderReport(current.display.report, theme, mode, now);
        }
        if (Predicate.isTagged(current.display, "problem")) {
          return renderProblem(theme, mode, current.display.problem);
        }
        return renderLoading(theme, mode, frame);
      };
      const full = renderMode("full");
      const compact = renderMode("compact");
      return [
        fixedVariant("full", full),
        fixedVariant("compact", compact),
        {
          id: "elastic",
          minWidth: 1,
          preferredWidth: visibleWidth(compact),
          render: (width) => truncateToWidth(compact, width, theme.fg("dim", "…")),
        },
      ];
    };

    const disable: Interface["disable"] = Effect.gen(function* () {
      yield* SynchronizedRef.update(state, (current) => ({
        ...current,
        context: Option.none(),
        requestRender: Option.none(),
      }));
      yield* FiberMap.remove(queries, "query");
    }).pipe(Effect.withSpan("Footer.Runway.disable"));

    yield* pipe(
      refresh(),
      Effect.schedule(Schedule.spaced(Duration.millis(config["refresh-interval-ms"]))),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* pipe(
      Effect.gen(function* () {
        const current = yield* SynchronizedRef.get(state);
        yield* Effect.sleep(
          Option.isSome(current.requestRender) &&
            Option.isSome(current.context) &&
            isCodexContext(current.context.value) &&
            Predicate.isTagged(current.display, "loading")
            ? Duration.millis(40)
            : Duration.seconds(1),
        );
        const latest = yield* SynchronizedRef.get(state);
        if (
          Option.isSome(latest.requestRender) &&
          Option.isSome(latest.context) &&
          isCodexContext(latest.context.value)
        ) {
          yield* Effect.sync(latest.requestRender.value);
        }
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => disable);

    return Service.of({ enable, variants, disable });
  }),
);

export * as Runway from "./index.ts";
