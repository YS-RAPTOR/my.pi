import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { Data, Effect, Layer } from "effect";
import { type Static, Type } from "typebox";
import { Notebook } from "#o/notebook";
import { Session } from "#o/session";
import { Outline, Status, statusColor, type StatusPhase } from "#o/ui";
import { Pi } from "@ys-raptor/pi-effect";

export const parameters = Type.Object(
  {
    name: Type.String({ description: "Human-readable notebook name" }),
  },
  { additionalProperties: false },
);

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  notebookId: Type.String(),
  name: Type.String(),
  artifactPath: Type.String(),
});

export type Details = Static<typeof detailsSchema>;

class CreateFailed extends Data.TaggedError("CreateFailed")<{
  readonly message: string;
}> {}

const empty = (): Component => new Container();

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() ?? "";

const displayName = (name: string | undefined) => {
  const line = name === undefined ? "" : firstLine(name);
  return line === "" ? undefined : line;
};

const card = (options: {
  readonly theme: Theme;
  readonly phase: StatusPhase;
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
    top: new Text(options.theme.fg(statusColor(options.phase), `CREATE · ${options.target}`), 0, 0),
    center,
  });
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const sessions = yield* Session.Service;

    yield* contributions.tool({
      name: "create",
      label: "Create Notebook",
      description:
        "Create a persistent notebook. The new notebook becomes current and is ready for push when this call succeeds.",
      promptSnippet: "Create a ready notebook and make it current",
      promptGuidelines: ["Use create before push when no current live notebook exists."],
      parameters,
      executionMode: "parallel",
      renderShell: "self",
      execute: (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) =>
        Effect.gen(function* () {
          const notebooks = yield* sessions.notebook;
          const summary = yield* notebooks.create(
            new Notebook.CreateInput({ name: input.name }),
          );
          const details: Details = {
            notebookId: summary.id,
            name: input.name,
            artifactPath: summary.artifactPath,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `Created notebook ${JSON.stringify(details.name)}: ${details.notebookId}. It is ready for push and is now current.`,
              },
            ],
            details,
          };
        }).pipe(
          Effect.withSpan("Orogeny.Tools.Create.execute"),
          Effect.mapError((error) => new CreateFailed({ message: error.message })),
        ),
      renderCall(input: Partial<Input> | undefined, theme, context) {
        if (!context.isPartial) return empty();
        const phase: StatusPhase = context.argsComplete ? "running" : "streaming";
        const name = displayName(input?.name);
        const target =
          name === undefined ? "new notebook" : phase === "streaming" ? `${name}…` : name;
        return card({
          theme,
          phase,
          target,
          status: phase === "streaming" ? "receiving name…" : "starting Deno kernel…",
        });
      },
      renderResult(result: AgentToolResult<Details>, options, theme, context) {
        if (options.isPartial) return empty();
        if (context.isError) {
          const content = result.content.find((part) => part.type === "text");
          return card({
            theme,
            phase: "error",
            target: displayName(context.args?.name) ?? "new notebook",
            status: content?.text ?? "creation failed",
          });
        }

        const details = result.details;
        if (details === undefined)
          return card({
            theme,
            phase: "done",
            target: displayName(context.args?.name) ?? "new notebook",
            status: "ready",
          });

        return card({
          theme,
          phase: "done",
          target: displayName(details.name) ?? details.notebookId,
          status: `ready · current · ${details.notebookId}`,
        });
      },
    });
  }),
);

export * as Create from "./create.ts";
