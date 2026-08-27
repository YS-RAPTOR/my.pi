import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  Array as Arr,
  Context,
  Data,
  Effect,
  HashSet,
  Layer,
  MutableHashMap,
  MutableHashSet,
  pipe,
} from "effect";

export class ToolNotFound extends Data.TaggedError("McpCapturedToolNotFound")<{
  readonly name: string;
}> {}

export class CommandNotFound extends Data.TaggedError("McpCapturedCommandNotFound")<{
  readonly name: string;
}> {}

export type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

export type Handle = Readonly<{
  api: ExtensionAPI;
  command: (name: string) => Effect.Effect<Command, CommandNotFound>;
  tool: (name: string) => Effect.Effect<ToolDefinition, ToolNotFound>;
  names: Effect.Effect<ReadonlyArray<string>>;
}>;

export class Service extends Context.Service<Service, Handle>()("orogeny/McpCapture") {}

type CapturedTool = ToolDefinition<any, any, any>;
type VirtualApi = ExtensionAPI &
  Readonly<{
    unregisterTool: (name: string) => boolean;
  }>;

const sourceInfo = {
  path: "<orogeny:mcp-capture>",
  source: "pi-mcp-adapter",
  scope: "temporary",
  origin: "top-level",
} as const;

export const layer = (host: ExtensionAPI) =>
  Layer.effect(
    Service,
    Effect.sync(() => {
      const commands = MutableHashMap.empty<string, Command>();
      const tools = MutableHashMap.empty<string, CapturedTool>();
      const active = MutableHashSet.empty<string>();

      const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
        if (name === "mcp-auth") MutableHashMap.set(commands, name, options);
        if (name !== "pi-mcp") host.registerCommand(name, options);
      };

      const registerTool: ExtensionAPI["registerTool"] = (tool) => {
        // SAFETY: the registry preserves each complete definition and erases only its
        // tool-specific parameter, detail, and renderer-state types.
        MutableHashMap.set(tools, tool.name, tool as CapturedTool);
        MutableHashSet.add(active, tool.name);
      };

      const unregisterTool = (name: string) => {
        const registered = MutableHashMap.has(tools, name);
        MutableHashMap.remove(tools, name);
        MutableHashSet.remove(active, name);
        return registered;
      };

      const getAllTools = (): ToolInfo[] => {
        const hostTools = host.getAllTools();
        const hostNames = pipe(
          hostTools,
          Arr.map((tool) => tool.name),
          HashSet.fromIterable,
        );
        const captured = pipe(
          MutableHashMap.values(tools),
          Arr.fromIterable,
          Arr.filter((tool) => !HashSet.has(hostNames, tool.name)),
          Arr.map((tool): ToolInfo => {
            const info: ToolInfo = {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              sourceInfo,
            };
            if (tool.promptGuidelines !== undefined) {
              info.promptGuidelines = tool.promptGuidelines;
            }
            return info;
          }),
        );
        return [...hostTools, ...captured];
      };

      const getActiveTools = () => {
        const hostTools = host.getActiveTools();
        const hostNames = HashSet.fromIterable(hostTools);
        const captured = pipe(
          active,
          Arr.fromIterable,
          Arr.filter((name) => !HashSet.has(hostNames, name)),
        );
        return [...hostTools, ...captured];
      };

      const setActiveTools = (names: string[]) => {
        MutableHashSet.clear(active);
        pipe(
          names,
          Arr.filter((name) => MutableHashMap.has(tools, name)),
          Arr.forEach((name) => MutableHashSet.add(active, name)),
        );
      };

      const api: VirtualApi = {
        ...host,
        registerCommand,
        registerTool,
        unregisterTool,
        getAllTools,
        getActiveTools,
        setActiveTools,
      };

      return Service.of({
        api,
        command: (name) =>
          pipe(
            Effect.sync(() => MutableHashMap.get(commands, name)),
            Effect.flatMap(Effect.fromOption(() => new CommandNotFound({ name }))),
          ),
        tool: (name) =>
          pipe(
            Effect.sync(() => MutableHashMap.get(tools, name)),
            Effect.flatMap(Effect.fromOption(() => new ToolNotFound({ name }))),
          ),
        names: Effect.sync(() => pipe(MutableHashMap.keys(tools), Arr.fromIterable)),
      });
    }),
  );
