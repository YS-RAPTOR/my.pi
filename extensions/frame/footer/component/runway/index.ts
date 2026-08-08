import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterVariant } from "../types.ts";
import {
  renderError,
  renderLoading,
  renderReport,
  renderUnavailable,
  type RunwayMode,
} from "./bar.ts";
import {
  isCodexContext,
  queryUsage,
  UsageUnavailableError,
  type UsageReport,
} from "./usage.ts";

const QUERY_INTERVAL_MS = 30_000;
const QUERY_TIMEOUT_MS = 15_000;
const MAX_CACHED_FAILURES = 5;

type Problem = "error" | "unavailable" | undefined;
type Timer = ReturnType<typeof setTimeout>;

function fixedVariant(id: string, text: string): FooterVariant {
  const width = visibleWidth(text);
  return {
    id,
    minWidth: width,
    preferredWidth: width,
    render: () => text,
  };
}

export class Runway {
  private context: ExtensionContext | undefined;
  private report: UsageReport | undefined;
  private problem: Problem;
  private failedRefreshes = 0;
  private loadingFrame = 0;
  private generation = 0;
  private enabled = false;
  private requestRender: (() => void) | undefined;
  private request: Promise<void> | undefined;
  private requestController: AbortController | undefined;
  private queryTimer: Timer | undefined;
  private displayTimer: Timer | undefined;

  enable(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (!this.enabled) {
      this.enabled = true;
      this.sync(true);
    } else {
      requestRender();
    }
  }

  updateContext(context: ExtensionContext): void {
    const activating = !isCodexContext(this.context) && isCodexContext(context);
    this.context = context;
    if (this.enabled) {
      this.sync(activating || (!this.report && !this.request));
    }
  }

  variants(theme: Theme): readonly FooterVariant[] {
    if (!isCodexContext(this.context)) return [];
    const loadingFrame =
      !this.report && !this.problem ? this.loadingFrame++ : this.loadingFrame;
    const now = Date.now();
    const full = this.render(theme, "full", loadingFrame, now);
    const compact = this.render(theme, "compact", loadingFrame, now);
    return [
      fixedVariant("full", full),
      fixedVariant("compact", compact),
      {
        id: "elastic",
        minWidth: 1,
        preferredWidth: visibleWidth(compact),
        render: (width) =>
          truncateToWidth(compact, width, theme.fg("dim", "…")),
      },
    ];
  }

  disable(): void {
    this.enabled = false;
    this.stopTimers();
    this.requestRender = undefined;
    this.context = undefined;
  }

  private render(
    theme: Theme,
    mode: RunwayMode,
    loadingFrame: number,
    now: number,
  ): string {
    if (this.report && this.failedRefreshes < MAX_CACHED_FAILURES) {
      return renderReport(this.report, theme, mode, now);
    }
    if (this.problem === "unavailable") return renderUnavailable(theme, mode);
    if (this.problem === "error") return renderError(theme, mode);
    return renderLoading(theme, mode, loadingFrame);
  }

  private sync(refresh: boolean): void {
    if (!isCodexContext(this.context)) {
      if (this.queryTimer || this.displayTimer || this.request)
        this.stopTimers();
    } else {
      this.startTimers();
      if (refresh) {
        this.problem = undefined;
        void this.refresh();
      }
    }
    this.requestRender?.();
  }

  private startTimers(): void {
    if (!this.queryTimer) {
      this.queryTimer = setInterval(
        () => void this.refresh(),
        QUERY_INTERVAL_MS,
      );
      this.queryTimer.unref?.();
    }
    if (!this.displayTimer) this.scheduleDisplay();
  }

  private scheduleDisplay(): void {
    if (!this.enabled || !isCodexContext(this.context)) {
      this.displayTimer = undefined;
      return;
    }
    this.displayTimer = setTimeout(
      () => {
        this.displayTimer = undefined;
        this.requestRender?.();
        this.scheduleDisplay();
      },
      !this.report && !this.problem ? 40 : 1_000,
    );
    this.displayTimer.unref?.();
  }

  private stopTimers(): void {
    this.generation += 1;
    this.requestController?.abort();
    if (this.queryTimer) clearInterval(this.queryTimer);
    if (this.displayTimer) clearTimeout(this.displayTimer);
    this.queryTimer = undefined;
    this.displayTimer = undefined;
    this.request = undefined;
    this.requestController = undefined;
  }

  private refresh(): Promise<void> {
    const context = this.context;
    if (!this.enabled || !context || !isCodexContext(context)) {
      return Promise.resolve();
    }
    if (this.request) return this.request;

    const generation = this.generation;
    this.requestController = new AbortController();
    this.request = queryUsage(context, {
      timeoutMs: QUERY_TIMEOUT_MS,
      signal: this.requestController.signal,
    })
      .then((report) => {
        if (generation !== this.generation) return;
        this.report = report;
        this.problem = undefined;
        this.failedRefreshes = 0;
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.failedRefreshes += 1;
        this.problem =
          error instanceof UsageUnavailableError ? "unavailable" : "error";
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.request = undefined;
        this.requestController = undefined;
        this.requestRender?.();
      });
    return this.request;
  }
}
