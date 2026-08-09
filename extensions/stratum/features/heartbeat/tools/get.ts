import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { Type, type Static } from "typebox";
import { Pi } from "#s/pi";
import {
  makeShellResourceRenderer,
  ShellCall,
  ShellFooter,
  ShellResource,
  ShellResult,
} from "#s/features/shell/tools/rendering";
import { Service } from "../service.ts";
import {
  detailsFromEntry,
  elapsed,
  entryDetailsSchema,
  modelContent,
  nextRun,
  remaining,
  type EntryDetails,
} from "./shared.ts";

export const parameters = Type.Object({});
export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  entry: Type.Union([entryDetailsSchema, Type.Null()]),
});

export type Details = Static<typeof detailsSchema>;

export const resourceModel = ShellResource.compose<Input, Details>(
  ShellResource.command(({ details }) => details?.entry?.instruction),
  ShellResource.metadata("interval", ({ details }) =>
    details?.entry === null || details?.entry === undefined
      ? undefined
      : `${details.entry.intervalSeconds}s`,
  ),
  ShellResource.metadata("expires", ({ details }) => {
    const expiresAt = details?.entry?.expiresAt;
    if (expiresAt === undefined) return;
    return expiresAt === null ? "never" : remaining(expiresAt);
  }),
  ShellResource.metadata("started", ({ details }) =>
    details?.entry === null || details?.entry === undefined
      ? undefined
      : elapsed(details.entry.startedAt),
  ),
  ShellResource.footer(
    ShellFooter.compose(
      ShellFooter.item(({ details }) =>
        details?.entry === null
          ? { text: "idle", tone: "muted" }
          : { text: "active", tone: "success" },
      ),
      ShellFooter.trailing(({ details }) =>
        details?.entry === null || details?.entry === undefined
          ? undefined
          : nextRun(details.entry),
      ),
    ),
  ),
);

export const modelFromEntry = (
  entry: EntryDetails,
  truncateInstruction = false,
): ShellResource.Model => {
  const details: Details = { entry };
  const model = resourceModel({
    input: {},
    result: { content: [], details },
    details,
    options: { expanded: false, isPartial: false },
    isError: false,
  });
  return truncateInstruction ? { ...model, truncateCommand: true } : model;
};

export const renderer = makeShellResourceRenderer<Input, Details>({
  call: ShellCall.compose(ShellCall.name("heartbeat_get")),
  resource: resourceModel,
  errorResult: ShellResult.compose(
    ShellResult.errorContent(),
    ShellResult.preview(7),
  ),
  errorFooter: ShellFooter.compose(
    ShellFooter.item(() => ({ text: "failed", tone: "error" })),
  ),
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const heartbeat = yield* Service;

    yield* contributions.tool({
      name: "heartbeat_get",
      label: "Get Heartbeat",
      description:
        "Get the current session heartbeat, including its instruction, interval, start time, next run, last run, and expiry. Returns no active heartbeat when stopped or expired.",
      promptSnippet: "Get the current session heartbeat",
      parameters,
      executionMode: "sequential",
      execute: Effect.fn("Heartbeat.Tools.Get.execute")(function* (
        _toolCallId: string,
        _input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) {
        const entry = yield* heartbeat.get;
        const current: EntryDetails | null =
          entry === null ? null : detailsFromEntry(entry);
        const details: Details = { entry: current };
        return {
          content: [
            {
              type: "text" as const,
              text:
                current === null
                  ? "No active heartbeat."
                  : modelContent(current),
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
