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
  text: Type.String({
    description:
      "Text to write verbatim; include a newline when input should be submitted",
    minLength: 1,
  }),
});

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  resourceId: Type.String(),
  mode: Type.Union([Type.Literal("stdio"), Type.Literal("pty")]),
  bytes: Type.Number(),
});

export type Details = Static<typeof detailsSchema>;

class ShellWriteFailed extends Data.TaggedError("ShellWriteFailed")<{
  readonly message: string;
}> {}

export const renderer = makeShellRenderer<Input, Details>({
  call: ShellCall.compose(
    ShellCall.name("shell_write"),
    ShellCall.mode(({ input }) =>
      Parts.modeFromResourceId(input?.resource_id)
    ),
    ShellCall.primary(({ input }) =>
      JSON.stringify(input?.text ?? "…")
    ),
  ),
  result: ShellResult.compose(
    ShellResult.errorContent(),
    ShellResult.preview(5),
  ),
  footer: ShellFooter.compose(
    ShellFooter.item(({ details, isError }) => {
      if (isError || details === undefined) {
        return { text: "failed", tone: "error" };
      }
      return {
        text: `wrote ${details.bytes} UTF-8 bytes`,
        tone: "success",
      };
    }),
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
      name: "shell_write",
      label: "Write to Shell",
      description:
        "Write text verbatim to a running shell resource. PTY resources receive terminal input; STDIO resources receive bytes on stdin. A newline is not appended automatically, so include \n when input should be submitted.",
      promptSnippet: "Write text to a running STDIO or PTY shell resource",
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
        yield* shell.write(resourceId, input.text);
        const bytes = new TextEncoder().encode(input.text).byteLength;
        const details: Details = {
          resourceId: resourceId.value,
          mode: summary.outputFile === undefined ? "pty" : "stdio",
          bytes,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Wrote ${bytes} UTF-8 bytes to ${resourceId.value}.`,
            },
          ],
          details,
        };
      }).pipe(
        Effect.withSpan("Shell.Tools.Write.execute"),
        Effect.mapError((error) =>
          Match.value(error).pipe(
            Match.tags({
              ResourceNotFound: ({ resourceId }) =>
                new ShellWriteFailed({
                  message: `Shell resource not found: ${resourceId.value}`,
                }),
              StdinClosed: ({ resourceId }) =>
                new ShellWriteFailed({
                  message: `Shell resource ${resourceId.value} is no longer accepting input`,
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
