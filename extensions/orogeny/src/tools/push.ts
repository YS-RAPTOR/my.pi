import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Data, Effect, HashSet, Layer, Match, Option, Schema, pipe } from "effect";
import { type Static, Type } from "typebox";
import { Config } from "#o/config";
import { Notebook } from "#o/notebook";
import { Session } from "#o/session";
import { Syntax } from "#o/syntax";
import { Outline, OutputView, Status, statusColor, SyntaxCode, type StatusPhase } from "#o/ui";
import { Pi } from "@ys-raptor/pi-effect";
import * as Wait from "./wait.ts";

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

export const detailsSchema = Wait.detailsSchema;

export type Details = Wait.Details;
type Output = Details["output"][number];

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

const summary = (cellId: string, target: string, details: Details) => {
  const admitted = `Admitted cell ${cellId} to ${target}.`;
  return pipe(
    Match.value(details),
    Match.when(
      { status: "running" },
      () => `${admitted} It is still running; use wait with the returned cursor to continue.`,
    ),
    Match.when(
      { hasMore: true },
      () => `${admitted} Use wait with the returned cursor to read the remaining output.`,
    ),
    Match.when({ status: "succeeded" }, () => `${admitted} It completed successfully.`),
    Match.when({ status: "failed" }, () => `${admitted} It completed with an error.`),
    Match.when({ status: "interrupted" }, () => `${admitted} It was interrupted.`),
    Match.orElse(() => admitted),
  );
};

const fit = (text: string, width: number) => (width <= 0 ? "" : truncateToWidth(text, width, "…"));

const pad = (text: string, width: number) => {
  const fitted = fit(text, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
};

class CellFooter implements Component {
  private readonly output: OutputView;
  private theme: Theme;
  private phase: StatusPhase = "running";
  private cellId = "cell";

  constructor(syntax: Syntax.Interface, codeTheme: Config.Value["syntax"]["theme"], theme: Theme) {
    this.output = new OutputView(syntax, codeTheme, theme);
    this.theme = theme;
  }

  update(options: {
    readonly theme: Theme;
    readonly phase: StatusPhase;
    readonly cellId: string;
    readonly output: ReadonlyArray<Output>;
    readonly expanded: boolean;
    readonly invalidate: () => void;
  }) {
    this.theme = options.theme;
    this.phase = options.phase;
    this.cellId = options.cellId;
    this.output.update(options);
    return this;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const color = statusColor(this.phase);
    const border = (text: string) => this.theme.fg(color, text);
    if (width === 1) return [border("├")];
    if (width === 2) return [border("├┤")];
    const innerWidth = width - 2;
    const padding = Math.min(3, Math.max(0, Math.floor((innerWidth - 1) / 2)));
    const contentWidth = Math.max(0, innerWidth - padding * 2);
    const content = this.output.render(contentWidth);
    const body = (line: string) =>
      border("│") +
      " ".repeat(padding) +
      pad(line, contentWidth) +
      " ".repeat(padding) +
      border("│");
    const label = fit(this.theme.fg(color, `CELL · ${this.cellId}`), width - 5);
    const divider =
      border("├─") +
      ` ${label} ` +
      border(`${"─".repeat(Math.max(0, width - visibleWidth(label) - 5))}┤`);
    const blank = body("");

    return content.length === 0 ? [divider, blank] : [divider, blank, ...content.map(body), blank];
  }

  invalidate(): void {
    this.output.invalidate();
  }
}

class PushView implements Component {
  private readonly code: SyntaxCode;
  private readonly footer: CellFooter;
  private outline: Outline | undefined;

  constructor(syntax: Syntax.Interface, codeTheme: Config.Value["syntax"]["theme"], theme: Theme) {
    this.code = new SyntaxCode(syntax, "typescript", codeTheme, theme);
    this.footer = new CellFooter(syntax, codeTheme, theme);
  }

  update(options: {
    readonly theme: Theme;
    readonly phase: StatusPhase;
    readonly target: string;
    readonly status: string;
    readonly cellId: string | undefined;
    readonly source: string;
    readonly output: ReadonlyArray<Output>;
    readonly expanded: boolean;
    readonly sealed: boolean;
    readonly invalidate: () => void;
  }) {
    const outline = {
      theme: options.theme,
      phase: options.phase,
      top: new Text(options.theme.fg(statusColor(options.phase), `PUSH · ${options.target}`), 0, 0),
      center: this.code.update(options),
      bottom: new Status(options.theme, {
        phase: options.phase,
        text: firstLine(options.status),
      }),
    };
    const footer =
      options.cellId === undefined
        ? undefined
        : this.footer.update({
            theme: options.theme,
            phase: options.phase,
            cellId: options.cellId,
            output: options.output,
            expanded: options.expanded,
            invalidate: options.invalidate,
          });
    this.outline = new Outline(footer === undefined ? outline : { ...outline, footer });
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
        "Admit one TypeScript cell to an idle notebook, briefly observe its execution, and return its status and available output. Omit notebookId to use the current notebook.",
      promptSnippet: "Submit TypeScript and briefly observe its execution",
      promptGuidelines: [
        "`push` briefly observes the submitted cell. Continue with `wait` and the returned cursor when the cell is still running or more output remains. Supplying `notebookId` also selects that notebook for later pushes.",
      ],
      parameters,
      executionMode: "parallel",
      renderShell: "self",
      execute: Effect.fn("Orogeny.Tools.Push.execute")(function* (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) {
        const notebooks = yield* pipe(
          sessions.notebook,
          Effect.mapError(
            () => new PushFailed({ message: "The notebook session is unavailable." }),
          ),
        );
        const notebookId =
          input.notebookId === undefined
            ? Option.none<Notebook.NotebookId>()
            : yield* pipe(
                Schema.decodeUnknownEffect(Notebook.NotebookId)(input.notebookId),
                Effect.map(Option.some),
                Effect.mapError(() => new PushFailed({ message: "The notebook ID is invalid." })),
              );
        const cellId = yield* pipe(
          notebooks.start(new Notebook.StartInput({ code: input.code, notebookId })),
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
        const observed = yield* pipe(
          Wait.observe(
            config,
            sessions,
            { cellId, timeoutMillis: config["push-wait-ms"] },
            onUpdate,
          ),
          Effect.mapError((error) => new PushFailed({ message: error.message })),
        );

        return {
          content: [
            ...observed.content,
            { type: "text" as const, text: summary(cellId, target, observed.details) },
          ],
          details: observed.details,
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
          cellId: undefined,
          source: input?.code ?? "",
          output: [],
          expanded: context.expanded,
          sealed: false,
          invalidate: context.invalidate,
        });
      },
      renderResult(result: AgentToolResult<Details>, options, theme, context) {
        const view = (context.state.view ??= new PushView(syntax, config.syntax.theme, theme));
        const details = result.details;
        const content = result.content.find((part) => part.type === "text");

        if (context.isError || details === undefined) {
          return view.update({
            theme,
            phase: "error",
            target: firstLine(context.args?.notebookId ?? "") || "current",
            status: content?.text ?? "cell admission failed",
            cellId: undefined,
            source: context.args?.code ?? "",
            output: [],
            expanded: options.expanded,
            sealed: true,
            invalidate: context.invalidate,
          });
        }

        const phase: StatusPhase = pipe(
          Match.value(details.status),
          Match.whenOr("waiting", "sleeping", "running", () => "running" as const),
          Match.when("succeeded", () => "done" as const),
          Match.orElse(() => "error" as const),
        );
        const status = pipe(
          Match.value(details),
          Match.when(
            { status: "waiting" },
            ({ remainingSeconds }) => `waiting · ${remainingSeconds ?? 0}s`,
          ),
          Match.orElse(({ status, output, hasMore, nextCursor }) =>
            [
              status,
              output.length === 0 ? "no output" : undefined,
              hasMore === true ? "more output" : undefined,
              nextCursor,
            ]
              .filter((value) => value !== undefined)
              .join(" · "),
          ),
        );

        return view.update({
          theme,
          phase,
          target: firstLine(context.args?.notebookId ?? "") || "current",
          status,
          cellId: details.cellId ?? undefined,
          source: context.args?.code ?? "",
          output: details.output,
          expanded: options.expanded,
          sealed: true,
          invalidate: context.invalidate,
        });
      },
    });
  }),
);

export * as Push from "./push.ts";
