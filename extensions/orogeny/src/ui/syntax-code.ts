import type { Theme } from "@earendil-works/pi-coding-agent";
import { Duration, Effect } from "effect";
import { Syntax } from "#o/syntax";
import { CodeTheme } from "./code-theme.ts";
import { Code } from "./code.ts";

const UPDATE_MILLIS = 16;
const IDLE_MILLIS = 40;

export class SyntaxCode {
  readonly component: Code;

  private readonly syntax: Syntax.Interface;
  private readonly language: string;
  private highlighter: Syntax.Highlighter | undefined;
  private source = "";
  private applied = "";
  private generation = 0;
  private state: "idle" | "running" | "waiting" | "disabled" | "settled" = "idle";
  private sealed = false;
  private needsVerification = false;
  private nextSyntaxAt = 0;
  private expanded = false;
  private rendering = false;
  private invalidate = () => {};
  private theme: Theme;

  constructor(
    syntax: Syntax.Interface,
    language: string,
    codeTheme: CodeTheme.Value,
    theme: Theme,
  ) {
    this.syntax = syntax;
    this.language = language;
    this.theme = theme;
    this.component = new Code(theme, codeTheme, { source: "", expanded: false });
  }

  update(options: {
    readonly theme: Theme;
    readonly source: string;
    readonly expanded: boolean;
    readonly sealed: boolean;
    readonly invalidate: () => void;
  }) {
    this.theme = options.theme;
    this.expanded = options.expanded;
    this.invalidate = options.invalidate;
    this.component.update(options.theme, {
      source: options.source,
      expanded: options.expanded,
    });

    if (!options.source.startsWith(this.source)) {
      this.generation++;
      this.highlighter = undefined;
      this.applied = "";
      this.state = "idle";
      this.sealed = false;
      this.needsVerification = false;
      this.nextSyntaxAt = 0;
    } else if (options.source !== this.source) {
      if (this.state === "settled") this.state = "idle";
      else if (this.state === "waiting") {
        this.generation++;
        this.state = "idle";
      }
    }

    this.source = options.source;
    this.sealed ||= options.sealed;
    this.rendering = true;
    try {
      this.start();
    } finally {
      this.rendering = false;
    }
    return this.component;
  }

  private apply(frame: Syntax.Frame) {
    this.component.update(this.theme, {
      source: this.source,
      expanded: this.expanded,
      frame,
    });
    if (!this.rendering && frame.startIndex < frame.endIndex) this.invalidate();
  }

  private finish() {
    if (this.needsVerification) return false;
    if (this.sealed) {
      this.state = "settled";
      this.highlighter = undefined;
    }
    return true;
  }

  private start() {
    if (this.state !== "idle" || this.source === "") return;
    this.state = "running";
    const generation = this.generation;

    const work = Effect.gen({ self: this }, function* () {
      const highlighter = this.highlighter ?? (yield* this.syntax.highlighter(this.language));
      if (generation !== this.generation) return;
      this.highlighter = highlighter;

      while (generation === this.generation) {
        if (this.applied !== this.source) {
          const delay = this.nextSyntaxAt - performance.now();
          if (delay > 0) yield* Effect.sleep(Duration.millis(delay));
          if (generation !== this.generation) return;

          const source = this.source;
          if (!source.startsWith(this.applied)) return;
          this.nextSyntaxAt = performance.now() + UPDATE_MILLIS;

          const frame = yield* highlighter.updateFrame(source);
          if (generation !== this.generation) return;
          this.applied = source;
          this.needsVerification = frame.needsRender;
          this.apply(frame);
          continue;
        }

        this.state = "waiting";
        yield* Effect.sleep(Duration.millis(IDLE_MILLIS));
        if (generation !== this.generation) return;
        this.state = "running";
        if (this.applied !== this.source) continue;
        if (this.finish()) return;

        const frame = yield* highlighter.completeFrame();
        if (generation !== this.generation) return;
        this.needsVerification = frame.needsRender;
        this.apply(frame);
        if (this.finish()) return;
      }
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          if (generation !== this.generation) return;
          this.state = "disabled";
          this.highlighter = undefined;
          this.needsVerification = false;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (generation !== this.generation || this.state !== "running") return;
          this.state = "idle";
          if (this.applied !== this.source || this.needsVerification) this.start();
        }),
      ),
    );

    Effect.runFork(work);
  }
}
