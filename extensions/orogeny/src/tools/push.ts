import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { Data, Duration, Effect, HashSet, Layer, Option, Schema } from "effect";
import { type Static, Type } from "typebox";
import { Config } from "#o/config";
import { Notebook } from "#o/notebook";
import { Session } from "#o/session";
import { Syntax } from "#o/syntax";
import { Code, Outline, Status, statusColor, type StatusPhase } from "#o/ui";
import { Pi } from "@ys-raptor/pi-effect";

export const parameters = Type.Object(
  {
    code: Type.String({
      description: "TypeScript or JavaScript source for one notebook cell",
    }),
    notebookId: Type.Optional(
      Type.String({
        description: "Full nb_... notebook ID; omit to use the current notebook",
      }),
    ),
  },
  { additionalProperties: false },
);

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  cellId: Type.String(),
});

export type Details = Static<typeof detailsSchema>;

class PushFailed extends Data.TaggedError("PushFailed")<{
  readonly message: string;
}> {}

type RendererState = {
  view?: PushView;
};

const SYNTAX_UPDATE_MILLIS = 16;
const SYNTAX_IDLE_MILLIS = 40;

const exposedFailures = HashSet.make(
  "resolve current notebook",
  "find notebook",
  "use notebook kernel",
  "start notebook cell",
);

const empty = (): Component => new Container();

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() ?? "";

export class PushCode {
  readonly component: Code;

  private readonly syntax: Syntax.Interface;
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

  constructor(syntax: Syntax.Interface, codeTheme: Config.Value["syntax"]["theme"], theme: Theme) {
    this.syntax = syntax;
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
      const highlighter = this.highlighter ?? (yield* this.syntax.highlighter("typescript"));
      if (generation !== this.generation) return;
      this.highlighter = highlighter;

      while (generation === this.generation) {
        if (this.applied !== this.source) {
          const delay = this.nextSyntaxAt - performance.now();
          if (delay > 0) yield* Effect.sleep(Duration.millis(delay));
          if (generation !== this.generation) return;

          const source = this.source;
          if (!source.startsWith(this.applied)) return;
          this.nextSyntaxAt = performance.now() + SYNTAX_UPDATE_MILLIS;

          const frame = yield* highlighter.updateFrame(source);
          if (generation !== this.generation) return;
          this.applied = source;
          this.needsVerification = frame.needsRender;
          this.apply(frame);
          continue;
        }

        this.state = "waiting";
        yield* Effect.sleep(Duration.millis(SYNTAX_IDLE_MILLIS));
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

class PushView implements Component {
  private readonly code: PushCode;
  private outline: Outline | undefined;
  private phase: StatusPhase | undefined;
  private target: string | undefined;
  private status: string | undefined;
  private themeKey: string | undefined;

  constructor(syntax: Syntax.Interface, codeTheme: Config.Value["syntax"]["theme"], theme: Theme) {
    this.code = new PushCode(syntax, codeTheme, theme);
  }

  update(options: {
    readonly theme: Theme;
    readonly phase: StatusPhase;
    readonly target: string;
    readonly status: string;
    readonly source: string;
    readonly expanded: boolean;
    readonly sealed: boolean;
    readonly invalidate: () => void;
  }) {
    const code = this.code.update(options);
    const status = firstLine(options.status);
    const themeKey =
      options.theme.fg(statusColor(options.phase), "") + options.theme.fg("text", "");

    if (
      this.phase === options.phase &&
      this.target === options.target &&
      this.status === status &&
      this.themeKey === themeKey
    )
      return this;

    this.phase = options.phase;
    this.target = options.target;
    this.status = status;
    this.themeKey = themeKey;
    this.outline = new Outline({
      theme: options.theme,
      phase: options.phase,
      top: new Text(options.theme.fg(statusColor(options.phase), `PUSH · ${options.target}`), 0, 0),
      center: code,
      bottom: new Status(options.theme, { phase: options.phase, text: status }),
    });
    return this;
  }

  render(width: number): string[] {
    return this.outline?.render(width) ?? [];
  }

  invalidate(): void {
    this.outline?.invalidate();
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service;
    const contributions = yield* Pi.Contributions.Service;
    const sessions = yield* Session.Service;
    const syntax = yield* Syntax.Service;

    yield* contributions.tool<typeof parameters, Details, RendererState, PushFailed>({
      name: "push",
      label: "Push Cell",
      description:
        "Admit one TypeScript cell to an existing idle notebook. Cells may embed other languages with the preloaded $language tagged templates. Omit notebookId to use the current notebook. Admission does not mean execution completed; use wait to observe status and output.",
      promptSnippet: "Admit TypeScript code to an existing notebook",
      promptGuidelines: [
        "Use push only with an existing idle notebook; use create first when no current live notebook exists.",
        "Every cell is TypeScript. Embed another language using its usual file extension as a preloaded tag: for example $py`...`, $ts`...`, or $html`...`.",
        "The readonly $languages array contains the supported extension tags without the leading $. Use $languages.includes(extension) to check an extension or $languages.filter(...) to search.",
        "Never place embedded-language source in an ordinary quoted string or untagged template literal. Always construct it with its $extension tag; reserve ordinary strings for normal data and prose.",
        "A $extension tag interpolates ${...} values and returns a plain string. It removes blank lines framing the template, then dedents every nonblank line by their exact common leading whitespace. Relative indentation and internal blank lines are preserved, trailing whitespace is not trimmed, and no newline is added. Indent multiline templates naturally within the TypeScript cell.",
        "Never emit source code with console.log or another plain-text output. Use await $extension.display(source) so the notebook preserves its language and syntax highlighting; for example, await $py.display(script).",
        "Inside a $language`...` value, escape a literal backtick as \\` and a literal ${ sequence as \\${. Never use ANSI control sequences as delimiters.",
        "After push succeeds, use wait with the returned cell ID to observe completion and output.",
      ],
      parameters,
      executionMode: "parallel",
      renderShell: "self",
      execute: Effect.fn("Orogeny.Tools.Push.execute")(function* (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) {
        const notebooks = yield* sessions.notebook.pipe(
          Effect.mapError(
            () => new PushFailed({ message: "The notebook session is unavailable." }),
          ),
        );
        const notebookId = yield* input.notebookId === undefined
          ? Effect.succeed(Option.none<Notebook.NotebookId>())
          : Schema.decodeUnknownEffect(Notebook.NotebookId)(input.notebookId).pipe(
              Effect.map(Option.some),
              Effect.mapError(() => new PushFailed({ message: "The notebook ID is invalid." })),
            );
        const cellId = yield* notebooks
          .start(new Notebook.StartInput({ code: input.code, notebookId }))
          .pipe(
            Effect.mapError(
              (error) =>
                new PushFailed({
                  message: HashSet.has(exposedFailures, error.operation)
                    ? error.message
                    : "The cell could not be admitted to the notebook.",
                }),
            ),
          );
        const target =
          input.notebookId === undefined ? "the current notebook" : `notebook ${input.notebookId}`;

        return {
          content: [
            {
              type: "text" as const,
              text: `Admitted cell ${cellId} to ${target}. Use wait to observe its status and output.`,
            },
          ],
          details: { cellId },
        };
      }),
      renderCall(input: Partial<Input> | undefined, theme, context) {
        if (!context.isPartial) return empty();
        const phase: StatusPhase = context.argsComplete ? "running" : "streaming";
        const notebookId = firstLine(input?.notebookId ?? "");
        const view = (context.state.view ??= new PushView(syntax, config.syntax.theme, theme));

        return view.update({
          theme,
          phase,
          target:
            notebookId === "" ? "current" : phase === "streaming" ? `${notebookId}…` : notebookId,
          status: phase === "streaming" ? "receiving code…" : "admitting cell…",
          source: input?.code ?? "",
          expanded: context.expanded,
          sealed: false,
          invalidate: context.invalidate,
        });
      },
      renderResult(result: AgentToolResult<Details>, options, theme, context) {
        if (options.isPartial) return empty();
        const view = (context.state.view ??= new PushView(syntax, config.syntax.theme, theme));
        const phase: StatusPhase = context.isError ? "error" : "done";
        const content = context.isError
          ? result.content.find((part) => part.type === "text")
          : undefined;

        return view.update({
          theme,
          phase,
          target: firstLine(context.args?.notebookId ?? "") || "current",
          status: context.isError
            ? (content?.text ?? "cell admission failed")
            : result.details === undefined
              ? "admitted"
              : `admitted · ${result.details.cellId}`,
          source: context.args?.code ?? "",
          expanded: options.expanded,
          sealed: true,
          invalidate: context.invalidate,
        });
      },
    });
  }),
);

export * as Push from "./push.ts";
