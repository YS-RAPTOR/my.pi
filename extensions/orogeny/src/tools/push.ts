import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { Data, Effect, HashSet, Layer, Option, Schema } from "effect";
import { type Static, Type } from "typebox";
import { Config } from "#o/config";
import { Notebook } from "#o/notebook";
import { Session } from "#o/session";
import { Syntax } from "#o/syntax";
import { Outline, Status, statusColor, SyntaxCode, type StatusPhase } from "#o/ui";
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

const exposedFailures = HashSet.make(
  "resolve current notebook",
  "find notebook",
  "use notebook kernel",
  "start notebook cell",
);

const empty = (): Component => new Container();

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() ?? "";

class PushView implements Component {
  private readonly code: SyntaxCode;
  private outline: Outline | undefined;
  private phase: StatusPhase | undefined;
  private target: string | undefined;
  private status: string | undefined;
  private themeKey: string | undefined;

  constructor(syntax: Syntax.Interface, codeTheme: Config.Value["syntax"]["theme"], theme: Theme) {
    this.code = new SyntaxCode(syntax, "typescript", codeTheme, theme);
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
        "Admit one TypeScript cell to an existing idle notebook. Omit notebookId to use the current notebook. Admission does not mean execution completed; use wait to observe status and output.",
      promptSnippet: "Admit TypeScript code to an existing notebook",
      promptGuidelines: [
        "Every cell is TypeScript.",
        "Use push only with an existing idle notebook; use create first when no current live notebook exists.",
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
