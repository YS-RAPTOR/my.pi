import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { Type, type Static } from "typebox";
import { Pi } from "#s/pi";
import {
  makeShellRenderer,
  ShellCall,
  ShellFooter,
  ShellResult,
} from "#s/features/shell/tools/rendering";
import { Service } from "../service.ts";

export const parameters = Type.Object({});
export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  stopped: Type.Boolean(),
});

export type Details = Static<typeof detailsSchema>;

export const renderer = makeShellRenderer<Input, Details>({
  call: ShellCall.compose(ShellCall.name("heartbeat_stop")),
  result: ShellResult.compose(
    ShellResult.errorContent(),
    ShellResult.preview(5),
  ),
  footer: ShellFooter.compose(
    ShellFooter.item(({ details, isError }) => {
      if (isError || details === undefined) {
        return { text: "failed", tone: "error" };
      }
      return details.stopped
        ? { text: "stopped", tone: "success" }
        : { text: "already idle", tone: "muted" };
    }),
  ),
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const heartbeat = yield* Service;

    yield* contributions.tool({
      name: "heartbeat_stop",
      label: "Stop Heartbeat",
      description:
        "Stop the current session heartbeat. This is idempotent and reports whether an active heartbeat was stopped.",
      promptSnippet: "Stop the current session heartbeat",
      parameters,
      executionMode: "sequential",
      execute: Effect.fn("Heartbeat.Tools.Stop.execute")(function* (
        _toolCallId: string,
        _input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) {
        const stopped = (yield* heartbeat.get) !== null;
        yield* heartbeat.stop;
        const details: Details = { stopped };
        return {
          content: [
            {
              type: "text" as const,
              text: stopped
                ? "Stopped the active heartbeat."
                : "No active heartbeat to stop.",
            },
          ],
          details,
        };
      }),
      renderCall: renderer.renderCall,
      renderResult: renderer.renderResult,
    });
  }),
);
