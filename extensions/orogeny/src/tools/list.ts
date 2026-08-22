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
import { Chunk, Data, Effect, Layer, Match, Option, pipe } from "effect";
import { type Static, Type } from "typebox";
import { Notebook } from "#o/notebook";
import { Session } from "#o/session";
import { Outline, Status, statusColor, type StatusPhase } from "#o/ui";
import { Pi } from "@ys-raptor/pi-effect";

const notebookStatus = Type.Union([
  Type.Literal("idle"),
  Type.Literal("busy"),
  Type.Literal("closed"),
]);

export const parameters = Type.Object(
  {
    status: Type.Optional(
      Type.Union([Type.Literal("idle"), Type.Literal("busy"), Type.Literal("closed")], {
        description: "Exact notebook status to include",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description: "Case-insensitive substring that notebook names must contain",
      }),
    ),
  },
  { additionalProperties: false },
);

export type Input = Static<typeof parameters>;

const notebookDetails = Type.Object({
  id: Type.String(),
  name: Type.String(),
  status: notebookStatus,
  current: Type.Boolean(),
  artifactPath: Type.String(),
  activeCellId: Type.Union([Type.String(), Type.Null()]),
});

export const detailsSchema = Type.Object({
  notebooks: Type.Array(notebookDetails),
});

export type Details = Static<typeof detailsSchema>;
type ListedNotebook = Details["notebooks"][number];

class ListFailed extends Data.TaggedError("ListFailed")<{
  readonly message: string;
}> {}

const empty = (): Component => new Container();

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() ?? "";

const filters = (input: Partial<Input> | undefined) => {
  const name = firstLine(input?.name ?? "") || "all";
  return `status=${input?.status ?? "all"} · name=${name}`;
};

const fit = (text: string, width: number) => (width <= 0 ? "" : truncateToWidth(text, width, "…"));

const pad = (text: string, width: number) => {
  const fitted = fit(text, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
};

const notebookAppearances = {
  idle: { marker: "○", color: "success" },
  busy: { marker: "›", color: "accent" },
  closed: { marker: "■", color: "muted" },
} as const;

class NotebookTable implements Component {
  private readonly theme: Theme;
  private readonly notebooks: ReadonlyArray<ListedNotebook>;

  constructor(theme: Theme, notebooks: ReadonlyArray<ListedNotebook>) {
    this.theme = theme;
    this.notebooks = notebooks;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const nameWidth = Math.min(24, Math.max(12, Math.floor(width * 0.24)));
    const statusWidth = 19;
    return this.notebooks.map((notebook) => {
      const appearance = notebookAppearances[notebook.status];
      const name = notebook.name;
      const status =
        this.theme.fg(appearance.color, notebook.status) +
        (notebook.current ? this.theme.fg("warning", " (current)") : "");
      const active =
        notebook.activeCellId === null
          ? ""
          : ` ${this.theme.fg("dim", "·")} ${this.theme.fg("muted", notebook.activeCellId)}`;
      return fit(
        `${this.theme.fg(appearance.color, appearance.marker)} ${pad(this.theme.fg("text", name), nameWidth)}${pad(status, statusWidth)}${this.theme.fg("muted", notebook.id)}${active}`,
        width,
      );
    });
  }

  invalidate(): void {}
}

const card = (options: {
  readonly theme: Theme;
  readonly phase: StatusPhase;
  readonly filter: string;
  readonly summary: string;
  readonly notebooks?: ReadonlyArray<ListedNotebook> | undefined;
}) => {
  const center = new Container();
  center.addChild(
    new Status(options.theme, {
      phase: options.phase,
      text: firstLine(options.summary),
    }),
  );
  if (options.notebooks !== undefined)
    center.addChild(new NotebookTable(options.theme, options.notebooks));

  return new Outline({
    theme: options.theme,
    phase: options.phase,
    top: new Text(options.theme.fg(statusColor(options.phase), `LIST · ${options.filter}`), 0, 0),
    center,
  });
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const sessions = yield* Session.Service;

    yield* contributions.tool({
      name: "list",
      label: "List Notebooks",
      description:
        "List notebooks and their artifact directories, optionally filtering by exact status and a case-insensitive name substring.",
      promptSnippet: "List notebooks, their current status, and artifact directories",
      promptGuidelines: [
        "Use list to find notebook IDs, active cell IDs, and artifact directories.",
        "The name filter is a case-insensitive contains search.",
      ],
      parameters,
      executionMode: "parallel",
      renderShell: "self",
      execute: Effect.fn("Orogeny.Tools.List.execute")(function* (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) {
        const notebooks = yield* sessions.notebook;
        const listed = yield* notebooks
          .list(
            new Notebook.ListInput({
              status: Option.fromUndefinedOr(input.status),
              name: Option.fromUndefinedOr(input.name),
            }),
          )
          .pipe(Effect.mapError((error) => new ListFailed({ message: error.message })));
        const values: Details["notebooks"] = Array.from(
          Chunk.map(listed, (notebook) => ({
            id: notebook.id,
            name: notebook.name,
            status: notebook.status,
            current: notebook.current,
            artifactPath: notebook.artifactPath,
            activeCellId: Option.getOrNull(notebook.activeCellId),
          })),
        );
        const count = values.length;
        const heading = pipe(
          Match.value(count),
          Match.when(0, () => "No notebooks matched the requested filters."),
          Match.when(1, () => "Found 1 notebook."),
          Match.orElse((value) => `Found ${value} notebooks.`),
        );
        const rows = pipe(
          values,
          Chunk.fromIterable,
          Chunk.map((notebook) => {
            const name = JSON.stringify(notebook.name);
            const current = notebook.current ? ", current" : "";
            const active =
              notebook.activeCellId === null ? "" : `, active cell ${notebook.activeCellId}`;
            return `- ${name} (${notebook.id}): ${notebook.status}${current}${active}. Artifact directory: ${notebook.artifactPath}.`;
          }),
          Chunk.join("\n"),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: rows === "" ? heading : `${heading}\n${rows}`,
            },
          ],
          details: { notebooks: values },
        };
      }),
      renderCall(input: Partial<Input> | undefined, theme, context) {
        if (!context.isPartial) return empty();
        const phase: StatusPhase = context.argsComplete ? "running" : "streaming";
        return card({
          theme,
          phase,
          filter: filters(input),
          summary: phase === "streaming" ? "receiving filters…" : "reading notebooks…",
        });
      },
      renderResult(result: AgentToolResult<Details>, options, theme, context) {
        if (options.isPartial) return empty();
        if (context.isError) {
          const content = result.content.find((part) => part.type === "text");
          return card({
            theme,
            phase: "error",
            filter: filters(context.args),
            summary: content?.text ?? "could not list notebooks",
          });
        }

        const notebooks = result.details?.notebooks ?? [];
        const count = notebooks.length;
        return card({
          theme,
          phase: "done",
          filter: filters(context.args),
          summary: pipe(
            Match.value(count),
            Match.when(0, () => "no notebooks"),
            Match.when(1, () => "1 notebook"),
            Match.orElse((value) => `${value} notebooks`),
          ),
          notebooks: options.expanded && count > 0 ? notebooks : undefined,
        });
      },
    });
  }),
);

export * as List from "./list.ts";
