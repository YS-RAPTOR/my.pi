import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { Type, type Static } from "typebox";
import { Pi } from "#s/pi";
import { Service } from "../service.ts";
import {
  detailsFromSummary,
  detailsSchema as resourceDetailsSchema,
  modelContent as resourceModelContent,
  type Details as ResourceDetails,
} from "./inspect.ts";
import {
  makeShellResourceListRenderer,
  Parts,
  ShellCall,
  ShellFooter,
  ShellResource,
  ShellResult,
} from "./rendering/index.ts";

export const parameters = Type.Object({
  active: Type.Optional(
    Type.Boolean({
      description:
        "Filter by activity: true returns running and draining resources; false returns completed and failed resources; omit to return all resources",
    }),
  ),
});

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  resources: Type.Array(resourceDetailsSchema),
});

export type Details = Static<typeof detailsSchema>;

export const resourceModel = ShellResource.compose<Input, ResourceDetails>(
  ShellResource.mode(({ details }) => details?.mode),
  ShellResource.command(({ details }) => details?.command),
  ShellResource.metadata("cwd", ({ details }) => details?.cwd),
  ShellResource.metadata("workspace", ({ details }) => details?.workspace),
  ShellResource.metadata("output", ({ details }) => details?.outputFile),
  ShellResource.metadata("started", ({ details }) =>
    details === undefined ? undefined : Parts.age(details.startedAt),
  ),
  ShellResource.footer(
    ShellFooter.compose(
      ShellFooter.item(Parts.lifecycleStatus),
      ShellFooter.item(Parts.exitOutcome),
      ShellFooter.item(Parts.failureMessage),
      ShellFooter.trailing(({ details }) => details?.resourceId),
    ),
    0,
  ),
);

export const modelFromDetails = (
  details: ResourceDetails,
): ShellResource.Model =>
  resourceModel({
    input: { active: true },
    result: { content: [], details },
    details,
    options: { expanded: false, isPartial: false },
    isError: false,
  });

export const renderer = makeShellResourceListRenderer<
  Input,
  Details,
  ResourceDetails
>({
  call: ShellCall.compose(
    ShellCall.name("shell_list"),
    ShellCall.metadata("active", ({ input }) =>
      input?.active === undefined ? "All" : String(input.active),
    ),
  ),
  resources: (details) => details.resources,
  resource: resourceModel,
  fallbackResult: ShellResult.compose(
    ShellResult.errorContent(),
    ShellResult.empty(({ details, isError }) => {
      if (isError || details === undefined || details.resources.length > 0) {
        return undefined;
      }
      return "No shell resources found.";
    }),
    ShellResult.preview(5),
  ),
  fallbackFooter: ShellFooter.compose(
    ShellFooter.item(({ details, isError }) => {
      if (isError || details === undefined) {
        return { text: "failed", tone: "error" };
      }
      return {
        text: `${details.resources.length} resources`,
        tone: "muted",
      };
    }),
  ),
});

const modelContent = (details: Details) => {
  if (details.resources.length === 0) {
    return "No shell resources found.";
  }
  const blocks: Array<string> = [`${details.resources.length} shell resources`];
  for (const resourceDetails of details.resources) {
    blocks.push(resourceModelContent(resourceDetails));
  }
  return blocks.join("\n\n");
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const shell = yield* Service;

    yield* contributions.tool({
      name: "shell_list",
      label: "List Shells",
      description:
        "List shell resources, including their command, working directory, mode, lifecycle, start time, output-log path, exit code, signal, and failure information.",
      promptSnippet: "List persistent STDIO and PTY shell resources",
      parameters,
      executionMode: "parallel",
      execute: Effect.fn("Shell.Tools.List.execute")(function* (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) {
        const resources: Array<ResourceDetails> = [];
        for (const summary of yield* shell.list(input.active)) {
          resources.push(detailsFromSummary(summary));
        }
        const details: Details = { resources };
        return {
          content: [{ type: "text" as const, text: modelContent(details) }],
          details,
        };
      }),
      renderCall: renderer.renderCall,
      renderResult: renderer.renderResult,
    });
  }),
);
