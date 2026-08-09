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
  resource_id: Type.String({ description: "STDIO shell resource ID" }),
});

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  resourceId: Type.String(),
  mode: Type.Literal("stdio"),
});

export type Details = Static<typeof detailsSchema>;

class ShellCloseStdinFailed extends Data.TaggedError(
  "ShellCloseStdinFailed",
)<{
  readonly message: string;
}> {}

export const renderer = makeShellRenderer<Input, Details>({
  call: ShellCall.compose(
    ShellCall.name("shell_close_stdin"),
    ShellCall.mode(({ input }) =>
      Parts.modeFromResourceId(input?.resource_id)
    ),
  ),
  result: ShellResult.compose(
    ShellResult.errorContent(),
    ShellResult.preview(5),
  ),
  footer: ShellFooter.compose(
    ShellFooter.item(({ details, isError }) =>
      isError || details === undefined
        ? { text: "failed", tone: "error" }
        : { text: "stdin closed", tone: "success" }
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
      name: "shell_close_stdin",
      label: "Close Shell Stdin",
      description:
        "Close stdin for a running STDIO shell resource. This sends EOF and allows commands waiting for input to finish. PTY resources do not support closing stdin.",
      promptSnippet: "Close stdin for a running STDIO shell resource",
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
        yield* shell.closeStdin(resourceId);
        const details: Details = {
          resourceId: resourceId.value,
          mode: "stdio",
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Closed stdin for ${resourceId.value}.`,
            },
          ],
          details,
        };
      }).pipe(
        Effect.withSpan("Shell.Tools.CloseStdin.execute"),
        Effect.mapError((error) =>
          Match.value(error).pipe(
            Match.tags({
              ResourceNotFound: ({ resourceId }) =>
                new ShellCloseStdinFailed({
                  message: `Shell resource not found: ${resourceId.value}`,
                }),
              CloseStdinUnavailable: ({ resourceId }) =>
                new ShellCloseStdinFailed({
                  message: `Shell resource ${resourceId.value} uses PTY and does not support closing stdin`,
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
