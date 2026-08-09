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
  resource_id: Type.String({ description: "Shell resource ID" }),
  signal: Type.String({
    description:
      "Signal to send, such as SIGINT, SIGTERM, SIGKILL, or SIGHUP",
    minLength: 1,
  }),
});

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  resourceId: Type.String(),
  mode: Type.Union([Type.Literal("stdio"), Type.Literal("pty")]),
  signal: Type.String(),
});

export type Details = Static<typeof detailsSchema>;

class ShellSignalFailed extends Data.TaggedError("ShellSignalFailed")<{
  readonly message: string;
}> {}

export const renderer = makeShellRenderer<Input, Details>({
  call: ShellCall.compose(
    ShellCall.name("shell_signal"),
    ShellCall.mode(({ input }) =>
      Parts.modeFromResourceId(input?.resource_id)
    ),
    ShellCall.primary(({ input }) => input?.signal),
  ),
  result: ShellResult.compose(
    ShellResult.errorContent(),
    ShellResult.preview(5),
  ),
  footer: ShellFooter.compose(
    ShellFooter.item(({ details, isError }) =>
      isError || details === undefined
        ? { text: "failed", tone: "error" }
        : { text: "signal sent", tone: "success" }
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
      name: "shell_signal",
      label: "Signal Shell",
      description:
        "Send a signal to a running shell resource. Use signals such as SIGINT, SIGTERM, SIGKILL, or SIGHUP.",
      promptSnippet: "Send a signal to a running STDIO or PTY shell resource",
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
        yield* shell.signal(resourceId, input.signal);
        const details: Details = {
          resourceId: resourceId.value,
          mode: summary.outputFile === undefined ? "pty" : "stdio",
          signal: input.signal,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Sent ${input.signal} to ${resourceId.value}.`,
            },
          ],
          details,
        };
      }).pipe(
        Effect.withSpan("Shell.Tools.Signal.execute"),
        Effect.mapError((error) =>
          Match.value(error).pipe(
            Match.tags({
              ResourceNotFound: ({ resourceId }) =>
                new ShellSignalFailed({
                  message: `Shell resource not found: ${resourceId.value}`,
                }),
              SignalFailed: ({ message }) =>
                new ShellSignalFailed({ message }),
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
