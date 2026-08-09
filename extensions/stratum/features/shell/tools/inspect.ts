import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Data, Effect, Layer, Match } from "effect";
import { Type, type Static } from "typebox";
import { Pi } from "#s/pi";
import { Service } from "../service.ts";
import { ResourceId, type ResourceSummary } from "../types.ts";
import {
  makeShellResourceRenderer,
  Parts,
  ShellCall,
  ShellFooter,
  ShellResource,
  ShellResult,
} from "./rendering/index.ts";

export const parameters = Type.Object({
  resource_id: Type.String({ description: "Shell resource ID" }),
});

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  resourceId: Type.String(),
  mode: Type.Union([Type.Literal("stdio"), Type.Literal("pty")]),
  command: Type.String(),
  cwd: Type.String(),
  workspace: Type.Optional(Type.String()),
  outputFile: Type.Optional(Type.String()),
  startedAt: Type.Number(),
  lifecycle: Type.Union([
    Type.Literal("running"),
    Type.Literal("draining"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  message: Type.Optional(Type.String()),
});

export type Details = Static<typeof detailsSchema>;

class ShellInspectFailed extends Data.TaggedError("ShellInspectFailed")<{
  readonly message: string;
}> {}

export const renderer = makeShellResourceRenderer<Input, Details>({
  call: ShellCall.compose(
    ShellCall.name("shell_inspect"),
    ShellCall.mode(({ input }) =>
      Parts.modeFromResourceId(input?.resource_id)
    ),
  ),
  resource: ShellResource.compose(
    ShellResource.command(({ details }) => details?.command),
    ShellResource.metadata("cwd", ({ details }) => details?.cwd),
    ShellResource.metadata("workspace", ({ details }) => details?.workspace),
    ShellResource.metadata("output", ({ details }) => details?.outputFile),
    ShellResource.metadata("started", ({ details }) =>
      details === undefined ? undefined : Parts.age(details.startedAt)
    ),
    ShellResource.footer(
      ShellFooter.compose(
        ShellFooter.item(Parts.lifecycleStatus),
        ShellFooter.item(Parts.exitOutcome),
        ShellFooter.item(Parts.failureMessage),
        ShellFooter.trailing(({ input, details }) =>
          details?.resourceId ?? input?.resource_id
        ),
      ),
    ),
  ),
  errorResult: ShellResult.compose(
    ShellResult.errorContent(),
    ShellResult.preview(5),
  ),
  errorFooter: ShellFooter.compose(
    ShellFooter.item(() => ({ text: "failed", tone: "error" })),
    ShellFooter.trailing(({ input }) => input?.resource_id),
  ),
});

export const detailsFromSummary = (summary: ResourceSummary): Details => {
  const details: Details = {
    resourceId: summary.resourceId.value,
    mode: summary.outputFile === undefined ? "pty" : "stdio",
    command: summary.cmd,
    cwd: summary.cwd,
    startedAt: summary.startedAt,
    lifecycle: "running",
  };

  if (summary.workspace !== undefined) {
    details.workspace = summary.workspace;
  }
  if (summary.outputFile !== undefined) {
    details.outputFile = summary.outputFile;
  }

  Match.value(summary.lifecycle).pipe(
    Match.tags({
      running: () => {},
      draining: ({ exitCode, signal }) => {
        details.lifecycle = "draining";
        details.exitCode = exitCode;
        details.signal = signal;
      },
      completed: ({ exitCode, signal }) => {
        details.lifecycle = "completed";
        details.exitCode = exitCode;
        details.signal = signal;
      },
      failed: ({ message }) => {
        details.lifecycle = "failed";
        details.message = message;
      },
    }),
    Match.exhaustive,
  );

  return details;
};

export const modelContent = (details: Details) => {
  const lines: Array<string> = [
    `Resource: ${details.resourceId}`,
    `Mode: ${details.mode.toUpperCase()}`,
    "Command:",
    details.command,
    `Cwd: ${details.cwd}`,
  ];
  if (details.workspace !== undefined) {
    lines.push(`Workspace: ${details.workspace}`);
  }
  if (details.outputFile !== undefined) {
    lines.push(`Output log: ${details.outputFile}`);
  }
  lines.push(`Started at: ${new Date(details.startedAt).toISOString()}`);
  lines.push(`Lifecycle: ${details.lifecycle}`);
  if (details.exitCode !== undefined) {
    lines.push(`Exit code: ${details.exitCode ?? "none"}`);
  }
  if (details.signal !== undefined) {
    lines.push(`Signal: ${details.signal ?? "none"}`);
  }
  if (details.message !== undefined) {
    lines.push(`Failure: ${details.message}`);
  }
  return lines.join("\n");
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const shell = yield* Service;

    yield* contributions.tool({
      name: "shell_inspect",
      label: "Inspect Shell",
      description:
        "Inspect a shell resource. Returns its command, working directory, mode, lifecycle, start time, output-log path, exit code, signal, and failure information.",
      promptSnippet: "Inspect a persistent shell resource and its lifecycle",
      parameters,
      executionMode: "parallel",
      execute: (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) => Effect.gen(function* () {
        const resourceId = new ResourceId({ value: input.resource_id });
        const summary = yield* shell.inspect(resourceId);
        const details = detailsFromSummary(summary);
        return {
          content: [
            { type: "text" as const, text: modelContent(details) },
          ],
          details,
        };
      }).pipe(
        Effect.withSpan("Shell.Tools.Inspect.execute"),
        Effect.mapError(({ resourceId }) =>
          new ShellInspectFailed({
            message: `Shell resource not found: ${resourceId.value}`,
          })
        ),
      ),
      renderCall: renderer.renderCall,
      renderResult: renderer.renderResult,
    });
  }),
);
