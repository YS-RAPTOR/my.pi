import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { Data, Effect, Layer, Match, pipe, Schema } from "effect";
import { type Static, Type } from "typebox";
import { Notebook } from "#o/notebook";
import { Session } from "#o/session";
import { Outline, Status, statusColor, type StatusPhase } from "#o/ui";
import { Pi } from "@ys-raptor/pi-effect";

export const parameters = Type.Object(
  {
    id: Type.String({
      description: "Full cell_... or nb_... ID to stop",
    }),
  },
  { additionalProperties: false },
);

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  targetType: Type.Union([Type.Literal("cell"), Type.Literal("notebook")]),
  targetId: Type.String(),
  before: Type.String(),
  after: Type.String(),
});

export type Details = Static<typeof detailsSchema>;

class StopFailed extends Data.TaggedError("StopFailed")<{
  readonly message: string;
}> {}

const empty = (): Component => new Container();

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() ?? "";

const targetType = (id: string | undefined): "cell" | "notebook" | "target" =>
  pipe(
    Match.value(id),
    Match.when(
      (value) => value?.startsWith("cell_") === true,
      () => "cell" as const,
    ),
    Match.when(
      (value) => value?.startsWith("nb_") === true,
      () => "notebook" as const,
    ),
    Match.orElse(() => "target" as const),
  );

const card = (options: {
  readonly theme: Theme;
  readonly phase: StatusPhase;
  readonly type: "cell" | "notebook" | "target";
  readonly target: string;
  readonly status: string;
}) => {
  const center = new Container();
  center.addChild(
    new Status(options.theme, {
      phase: options.phase,
      text: firstLine(options.status),
    }),
  );

  return new Outline({
    theme: options.theme,
    phase: options.phase,
    top: new Text(
      options.theme.fg(
        statusColor(options.phase),
        `STOP${options.type === "target" ? "" : ` ${options.type.toUpperCase()}`} · ${options.target}`,
      ),
      0,
      0,
    ),
    center,
  });
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const sessions = yield* Session.Service;

    yield* contributions.tool({
      name: "stop",
      label: "Stop Cell or Notebook",
      description: "Stop a running cell or close a notebook. Pass the full cell_... or nb_... ID.",
      promptSnippet: "Stop a cell or close a notebook by ID",
      promptGuidelines: [
        "Use stop with a cell ID to stop that cell.",
        "Use stop with a notebook ID to close that notebook.",
      ],
      parameters,
      executionMode: "parallel",
      renderShell: "self",
      execute: Effect.fn("Orogeny.Tools.Stop.execute")(function* (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) {
        const notebooks = yield* sessions.notebook;

        if (input.id.startsWith("cell_")) {
          const id = yield* Schema.decodeUnknownEffect(Notebook.CellId)(input.id).pipe(
            Effect.mapError(() => new StopFailed({ message: "invalid cell ID" })),
          );
          const result = yield* notebooks.stopCell(id).pipe(
            Effect.mapError(
              (error) =>
                new StopFailed({
                  message: error.operation === "find cell" ? "cell not found" : error.message,
                }),
            ),
          );
          const details: Details = {
            targetType: "cell",
            targetId: id,
            before: result.before,
            after: result.after,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: pipe(
                  Match.value(result),
                  Match.when(
                    { before: "interrupted", after: "interrupted" },
                    () => `Cell ${id} was already stopped; no action was needed.`,
                  ),
                  Match.when(
                    { before: "succeeded", after: "succeeded" },
                    () => `Cell ${id} had already succeeded; no stop action was needed.`,
                  ),
                  Match.when(
                    { before: "failed", after: "failed" },
                    () => `Cell ${id} had already failed; no stop action was needed.`,
                  ),
                  Match.when({ after: "interrupted" }, () => `Stopped running cell ${id}.`),
                  Match.when(
                    { after: "killed" },
                    () =>
                      `Cell ${id} could not be stopped independently, so its notebook was stopped.`,
                  ),
                  Match.when(
                    { after: "succeeded" },
                    () => `Cell ${id} completed successfully before it could be stopped.`,
                  ),
                  Match.orElse(() => `Cell ${id} failed before it could be stopped.`),
                ),
              },
            ],
            details,
          };
        }

        if (input.id.startsWith("nb_")) {
          const id = yield* Schema.decodeUnknownEffect(Notebook.NotebookId)(input.id).pipe(
            Effect.mapError(() => new StopFailed({ message: "invalid notebook ID" })),
          );
          const result = yield* notebooks.stopNotebook(id).pipe(
            Effect.mapError(
              (error) =>
                new StopFailed({
                  message:
                    error.operation === "find notebook" ? "notebook not found" : error.message,
                }),
            ),
          );
          const details: Details = {
            targetType: "notebook",
            targetId: id,
            before: result.before,
            after: result.after,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: pipe(
                  Match.value(result.before),
                  Match.when(
                    "closed",
                    () => `Notebook ${id} was already closed; no stop action was needed.`,
                  ),
                  Match.when("busy", () => `Stopped the active cell and closed notebook ${id}.`),
                  Match.orElse(() => `Closed notebook ${id}.`),
                ),
              },
            ],
            details,
          };
        }

        return yield* new StopFailed({
          message: "target must be a full cell or notebook ID",
        });
      }),
      renderCall(input: Partial<Input> | undefined, theme, context) {
        if (!context.isPartial) return empty();
        const phase: StatusPhase = context.argsComplete ? "running" : "streaming";
        const id = firstLine(input?.id ?? "") || "target";
        const type = targetType(input?.id);
        return card({
          theme,
          phase,
          type,
          target: phase === "streaming" && id !== "target" ? `${id}…` : id,
          status: pipe(
            Match.value({ phase, type }),
            Match.when({ phase: "streaming" }, () => "receiving target…"),
            Match.when({ type: "cell" }, () => "running → interrupting"),
            Match.when({ type: "notebook" }, () => "open → closing"),
            Match.orElse(() => "resolving target…"),
          ),
        });
      },
      renderResult(result: AgentToolResult<Details>, options, theme, context) {
        if (options.isPartial) return empty();
        const id = firstLine(context.args?.id ?? "") || "target";
        const type = targetType(context.args?.id);
        if (context.isError) {
          const content = result.content.find((part) => part.type === "text");
          return card({
            theme,
            phase: "error",
            type,
            target: id,
            status: content?.text ?? "stop failed",
          });
        }

        const details = result.details;
        if (details === undefined)
          return card({
            theme,
            phase: "done",
            type,
            target: id,
            status: "stopped",
          });

        return card({
          theme,
          phase: "done",
          type: details.targetType,
          target: details.targetId,
          status: pipe(
            Match.value(details),
            Match.when(
              ({ before, after }) => before === after,
              ({ after }) => `already ${after}`,
            ),
            Match.orElse(({ before, after }) => `${before} → ${after}`),
          ),
        });
      },
    });
  }),
);

export * as Stop from "./stop.ts";
