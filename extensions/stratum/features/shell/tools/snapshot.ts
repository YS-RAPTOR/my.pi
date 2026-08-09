import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Data, Effect, Layer, Match } from "effect";
import { Type, type Static } from "typebox";
import { Pi } from "#s/pi";
import { Service } from "../service.ts";
import { ResourceId } from "../types.ts";
import {
  makeShellRenderer,
  Parts,
  ShellCall,
  ShellFooter,
  ShellResult,
} from "./rendering/index.ts";

export const parameters = Type.Object({
  resource_id: Type.String({ description: "PTY shell resource ID" }),
  lines: Type.Optional(
    Type.Union(
      [Type.Integer({ minimum: 1 }), Type.Null()],
      {
        description:
          "Trailing visible-terminal lines to capture. Use a positive integer to limit the result. Set null or omit this field to capture the complete visible terminal.",
      },
    ),
  ),
});

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  resourceId: Type.String(),
  output: Type.String(),
  revision: Type.Number(),
  lifecycle: Type.Union([
    Type.Literal("running"),
    Type.Literal("draining"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  message: Type.Optional(Type.String()),
  truncated: Type.Boolean(),
  totalLines: Type.Number(),
  outputLines: Type.Number(),
});

export type Details = Static<typeof detailsSchema>;

class ShellSnapshotFailed extends Data.TaggedError("ShellSnapshotFailed")<{
  readonly message: string;
}> {}

const resultText = (details: Details) => {
  const output = details.output.length > 0 ? details.output : "(empty terminal)";
  const truncation = details.truncated
    ? " Snapshot truncated; request fewer lines if a smaller capture is needed."
    : "";
  const outcome =
    details.exitCode !== undefined || details.signal !== undefined
      ? ` Exit code: ${details.exitCode ?? "none"}. Signal: ${details.signal ?? "none"}.`
      : "";
  const failure =
    details.message === undefined ? "" : ` Failure: ${details.message}`;
  return `${output}\n\n[PTY snapshot for ${details.resourceId}. Lifecycle: ${details.lifecycle}.${outcome} Revision: ${details.revision}.${truncation}${failure}]`;
};

export const renderer = makeShellRenderer<Input, Details>({
  call: ShellCall.compose(
    ShellCall.name("shell_snapshot"),
    ShellCall.mode(({ input }) =>
      Parts.modeFromResourceId(input?.resource_id) ?? "pty"
    ),
    ShellCall.metadata("lines", ({ input }) =>
      input?.lines === null ? "visible" : input?.lines
    ),
  ),
  result: ShellResult.compose(
    ShellResult.output(({ details }) => details?.output),
    ShellResult.errorContent(),
    ShellResult.empty(() => "(empty terminal)"),
    ShellResult.preview(5),
  ),
  footer: ShellFooter.compose(
    ShellFooter.item(Parts.lifecycleStatus),
    ShellFooter.item(Parts.exitOutcome),
    ShellFooter.item(Parts.failureMessage),
    ShellFooter.item(({ details }) =>
      details === undefined
        ? undefined
        : { text: `revision ${details.revision}`, tone: "muted" }
    ),
    ShellFooter.trailing(({ details }) =>
      details?.truncated === true
        ? { text: "snapshot truncated", tone: "warning" }
        : undefined
    ),
    ShellFooter.trailing(({ input, details }) =>
      details?.resourceId ?? input?.resource_id
    ),
  ),
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const shell = yield* Service;

    yield* contributions.tool({
      name: "shell_snapshot",
      label: "Snapshot Shell",
      description:
        "Capture the complete visible terminal of a PTY shell resource. Optionally limit the capture to trailing lines. STDIO resources do not support terminal snapshots; read their output log instead.",
      promptSnippet: "Capture the current visible terminal of a PTY shell",
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
        const snapshot = yield* shell.snapshot(resourceId, null);
        const hadTrailingNewline = snapshot.text.endsWith("\n");
        const terminalLines = snapshot.text.split("\n");
        if (hadTrailingNewline) terminalLines.pop();
        const requestedLines = input.lines ?? undefined;
        const lineLimited =
          requestedLines !== undefined &&
          terminalLines.length > requestedLines;
        const selectedLines =
          requestedLines === undefined
            ? terminalLines
            : terminalLines.slice(-requestedLines);
        const selected =
          selectedLines.join("\n") +
          (hadTrailingNewline && selectedLines.length > 0 ? "\n" : "");
        const lifecycle = Match.value(snapshot.lifecycle).pipe(
          Match.tags({
            running: () => ({ lifecycle: "running" as const }),
            draining: ({ exitCode, signal }) => ({
              lifecycle: "draining" as const,
              exitCode,
              signal,
            }),
            completed: ({ exitCode, signal }) => ({
              lifecycle: "completed" as const,
              exitCode,
              signal,
            }),
            failed: ({ message }) => ({
              lifecycle: "failed" as const,
              message,
            }),
          }),
          Match.exhaustive,
        );
        const details: Details = {
          resourceId: resourceId.value,
          output: selected,
          revision: snapshot.revision,
          ...lifecycle,
          truncated: snapshot.truncated || lineLimited,
          totalLines: terminalLines.length,
          outputLines: selectedLines.length,
        };
        return {
          content: [{ type: "text" as const, text: resultText(details) }],
          details,
        };
      }).pipe(
        Effect.withSpan("Shell.Tools.Snapshot.execute"),
        Effect.mapError((error) =>
          Match.value(error).pipe(
            Match.tags({
              ResourceNotFound: ({ resourceId }) =>
                new ShellSnapshotFailed({
                  message: `Shell resource not found: ${resourceId.value}`,
                }),
              SnapshotUnavailable: ({ resourceId }) =>
                new ShellSnapshotFailed({
                  message: `Shell resource ${resourceId.value} uses STDIO and has no terminal snapshot; inspect it and read its output log instead`,
                }),
              SnapshotFailed: ({ resourceId, message }) =>
                new ShellSnapshotFailed({
                  message: `Unable to capture ${resourceId.value}: ${message}`,
                }),
            }),
            Match.exhaustive,
          ),
        ),
      ),
      renderCall: renderer.renderCall,
      renderResult: renderer.renderResult,
    });
  }),
);
