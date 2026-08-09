import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Clock, Data, Effect, Layer } from "effect";
import { Type, type Static } from "typebox";
import { Pi } from "#s/pi";
import {
  makeShellRenderer,
  ShellCall,
  ShellFooter,
  ShellResult,
} from "#s/features/shell/tools/rendering";
import { Service } from "../service.ts";
import { Start } from "../types.ts";
import {
  detailsFromEntry,
  entryDetailsSchema,
  modelContent,
  nextRun,
  type EntryDetails,
} from "./shared.ts";

export const parameters = Type.Object({
  interval_seconds: Type.Integer({
    minimum: 1,
    description: "Seconds between heartbeat checks",
  }),
  instruction: Type.String({
    minLength: 1,
    description: "Instruction to send when the heartbeat fires",
  }),
  expires_in_seconds: Type.Union(
    [Type.Integer({ minimum: 1 }), Type.Null()],
    {
      default: null,
      description:
        "Seconds until the heartbeat expires, or null to never expire. Defaults to null.",
    },
  ),
});

export type Input = Static<typeof parameters>;
export const detailsSchema = entryDetailsSchema;
export type Details = EntryDetails;

class HeartbeatStartFailed extends Data.TaggedError(
  "HeartbeatStartFailed",
)<{
  readonly message: string;
}> {}

export const renderer = makeShellRenderer<Input, Details>({
  call: ShellCall.compose(
    ShellCall.name("heartbeat_start"),
    ShellCall.primary(({ input }) => input?.instruction),
    ShellCall.metadata(
      "interval",
      ({ input }) =>
        input?.interval_seconds === undefined
          ? undefined
          : `${input.interval_seconds}s`,
    ),
    ShellCall.metadata("expires", ({ input }) => {
      if (input?.expires_in_seconds === undefined) return;
      return input.expires_in_seconds === null
        ? "never"
        : `${input.expires_in_seconds}s`;
    }),
  ),
  result: ShellResult.compose(
    ShellResult.errorContent(),
    ShellResult.preview(7),
  ),
  footer: ShellFooter.compose(
    ShellFooter.item(({ details, isError }) =>
      isError || details === undefined
        ? { text: "failed", tone: "error" }
        : { text: "active", tone: "success" },
    ),
    ShellFooter.trailing(({ details }) =>
      details === undefined ? undefined : nextRun(details),
    ),
  ),
});

const messageFrom = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Unable to start heartbeat";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const heartbeat = yield* Service;

    yield* contributions.tool({
      name: "heartbeat_start",
      label: "Start Heartbeat",
      description:
        "Start or replace the current session heartbeat. The heartbeat periodically sends its instruction as a follow-up user message. Set expires_in_seconds to null for no expiry.",
      promptSnippet:
        "Start or replace the current session's periodic heartbeat",
      parameters,
      executionMode: "sequential",
      execute: (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const expiresInSeconds = input.expires_in_seconds ?? null;
          const entry = yield* heartbeat.start(
            new Start({
              intervalSeconds: input.interval_seconds,
              instruction: input.instruction,
              expiresAt:
                expiresInSeconds === null
                  ? null
                  : now + expiresInSeconds * 1_000,
            }),
          );
          const details = detailsFromEntry(entry);
          return {
            content: [
              { type: "text" as const, text: modelContent(details) },
            ],
            details,
          };
        }).pipe(
          Effect.withSpan("Heartbeat.Tools.Start.execute"),
          Effect.mapError(
            (cause) =>
              new HeartbeatStartFailed({ message: messageFrom(cause) }),
          ),
        ),
      renderCall: renderer.renderCall,
      renderResult: renderer.renderResult,
    });
  }),
);
