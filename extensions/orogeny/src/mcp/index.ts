import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createMcpAdapter,
  loadMcpConfig,
  registerMcpServer,
  type ServerEntry,
} from "./adapter.mjs";
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  Scope,
  pipe,
} from "effect";
import { Bridge } from "#o/bridge";
import * as Capture from "./capture.ts";

const ServerInput = Schema.Struct({ server: Schema.String });
const SearchInput = Schema.Struct({
  query: Schema.String,
  server: Schema.optionalKey(Schema.String),
  regex: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
const ToolInput = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  args: Schema.Record(Schema.String, Schema.Json),
});
const options = { onExcessProperty: "error" } as const;
const decodeServer = Schema.decodeUnknownEffect(ServerInput, options);
const decodeSearch = Schema.decodeUnknownEffect(SearchInput, options);
const decodeTool = Schema.decodeUnknownEffect(ToolInput, options);

type Content =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "image"; data: string; mimeType: string }>;

type FailureDetails = Readonly<{
  error?: string;
  message?: string;
}>;

type Result<Details extends FailureDetails> = Readonly<{
  content: Array<Content>;
  details: Details;
}>;

type StatusDetails = FailureDetails &
  Readonly<{
    servers: Array<{
      name: string;
      status: "connected" | "cached" | "failed" | "needs-auth" | "not connected" | "disabled";
      toolCount: number;
      failedAgo: number | null;
    }>;
  }>;

type SearchDetails = FailureDetails &
  Readonly<{
    matches: Array<{ server: string; tool: string }>;
    nextOffset: number | null;
  }>;

type ListDetails = FailureDetails & Readonly<{ tools: Array<string> }>;

type DescribeDetails = FailureDetails &
  Readonly<{
    server: string;
    tool: {
      originalName: string;
      description: string;
      inputSchema?: Schema.Json;
    };
  }>;

type McpResult = Readonly<{
  content: Array<Schema.Json>;
  structuredContent?: Schema.Json;
  _meta?: Schema.Json;
  isError?: boolean;
}>;

type CallDetails = FailureDetails & Readonly<{ mcpResult?: McpResult }>;

export type Interface = Readonly<{
  open: (context: ExtensionContext) => Effect.Effect<void, Bridge.Failed, Scope.Scope>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Mcp") {}

class Aborted extends Error {
  override readonly name = "AbortError";
}

const adapterConfig = {
  mcpServers: {},
  settings: {
    toolPrefix: "server",
    directTools: false,
    disableProxyTool: false,
    scriptMode: false,
    outputGuard: false,
    hostConfigDiscovery: "off",
    mcpFooterStatus: "off",
    notifyOnStartupConnect: false,
    autoAuth: false,
    sampling: true,
    samplingAutoApprove: false,
    elicitation: true,
    trace: { enabled: false },
  },
} as const;

const messageFrom = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const failed = (
  message: string,
  content: ReadonlyArray<Schema.Json> = [],
  details: Schema.Json = {},
) =>
  new Bridge.Failed({
    errorName: "MCPError",
    message,
    data: Option.some({ message, content, details }),
  });

const firstText = <Details extends FailureDetails>(result: Result<Details>) =>
  pipe(
    result.content,
    Arr.filter((content) => content.type === "text"),
    Arr.head,
    Option.map((content) => content.text),
  );

const resultMessage = <Details extends FailureDetails>(result: Result<Details>) =>
  result.details.message ??
  pipe(
    firstText(result),
    Option.getOrElse(() => "The MCP operation failed."),
  );

const reject = <Details extends FailureDetails>(result: Result<Details>) =>
  pipe(
    Match.value(result.details.error),
    Match.when(undefined, () => Effect.void),
    Match.when("aborted", () => Effect.fail(new Aborted(resultMessage(result)))),
    Match.orElse(() =>
      Effect.fail(
        failed(
          resultMessage(result),
          result.content,
          // SAFETY: adapter detail records are JSON values by MCP contract.
          result.details as Schema.Json,
        ),
      ),
    ),
  );

const invalid = (expected: string, cause: { readonly message: string }) =>
  failed(`Invalid input. Expected: ${expected}. ${cause.message}`);

const normalizeServer = (definition: ServerEntry): ServerEntry => ({
  ...structuredClone(definition),
  directTools: false,
  lifecycle: definition.lifecycle ?? "lazy",
  protocolVersion: definition.protocolVersion ?? "auto",
});

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bridge = yield* Bridge.Service;
    const captured = yield* Capture.Service;
    const context = yield* Ref.make(Option.none<ExtensionContext>());

    yield* Effect.sync(() => createMcpAdapter({ config: adapterConfig })(captured.api));

    const current = pipe(
      Ref.get(context),
      Effect.flatMap(Effect.fromOption(() => failed("The notebook session is unavailable."))),
    );

    const invoke = <Details extends FailureDetails>(input: Record<string, Schema.Json>) =>
      Effect.gen(function* () {
        const active = yield* current;
        const definition = yield* pipe(
          captured.tool("mcp"),
          Effect.mapError(() =>
            failed("The embedded MCP adapter did not register its proxy tool."),
          ),
        );
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            definition.execute(
              `orogeny-mcp-${crypto.randomUUID()}`,
              input,
              signal,
              undefined,
              active,
            ),
          catch: (cause) =>
            cause instanceof Error && cause.name === "AbortError"
              ? new Aborted(cause.message)
              : failed(messageFrom(cause)),
        });
        // SAFETY: the pinned adapter proxy always returns JSON content and mode-specific details.
        return result as Result<Details>;
      });

    const describe = Effect.fn("Orogeny.Mcp.describe")(function* (name: string) {
      const result = yield* invoke<DescribeDetails>({ describe: name });
      yield* reject(result);
      const output = {
        server: result.details.server,
        tool: result.details.tool.originalName,
        description: result.details.tool.description,
      };
      if (result.details.tool.inputSchema === undefined) return output;
      return { ...output, inputSchema: result.details.tool.inputSchema };
    });

    const list = Effect.fn("Orogeny.Mcp.list")(function* () {
      const result = yield* invoke<StatusDetails>({});
      yield* reject(result);
      return pipe(
        result.details.servers,
        Arr.map((server) => {
          const output = {
            name: server.name,
            status: server.status === "not connected" ? "not-connected" : server.status,
            toolCount: server.toolCount,
          } as const;
          if (server.status !== "failed" || server.failedAgo === null) return output;
          return { ...output, failedAgoSeconds: server.failedAgo };
        }),
      );
    });

    const search = Effect.fn("Orogeny.Mcp.search")(function* (input: typeof SearchInput.Type) {
      if (input.server !== undefined) {
        const servers = yield* list();
        if (!Arr.some(servers, (server) => server.name === input.server))
          return yield* failed(`MCP server ${JSON.stringify(input.server)} was not found.`);
      }
      if (input.query.trim() === "") return { items: [], nextOffset: null };

      const result = yield* invoke<SearchDetails>({ ...input, includeSchemas: false });
      yield* reject(result);
      return {
        items: yield* Effect.forEach(result.details.matches, (match) => describe(match.tool)),
        nextOffset: result.details.nextOffset,
      };
    });

    const withConnection = Effect.fn("Orogeny.Mcp.withConnection")(function* <
      Details extends FailureDetails,
    >(server: string, request: Effect.Effect<Result<Details>, Bridge.Failed | Aborted>) {
      const initial = yield* request;
      if (initial.details.error !== "not_connected") return initial;
      const connected = yield* invoke<FailureDetails>({ connect: server });
      yield* reject(connected);
      return yield* request;
    });

    const serverList = Effect.fn("Orogeny.Mcp.serverList")(function* (server: string) {
      const result = yield* withConnection(server, invoke<ListDetails>({ server }));
      yield* reject(result);
      return yield* Effect.forEach(result.details.tools, (name) =>
        pipe(
          describe(name),
          Effect.map(({ server: _, ...description }) => description),
        ),
      );
    });

    const instructions = Effect.fn("Orogeny.Mcp.instructions")(function* (server: string) {
      const result = yield* withConnection(
        server,
        invoke<FailureDetails>({ instructions: server }),
      );
      if (result.details.error === "no_instructions") return null;
      yield* reject(result);
      const text = yield* pipe(
        firstText(result),
        Effect.fromOption(() =>
          failed(
            "The MCP server returned invalid instructions.",
            result.content,
            // SAFETY: adapter detail records are JSON values by MCP contract.
            result.details as Schema.Json,
          ),
        ),
      );
      const prefix = `${server} instructions:\n\n`;
      return text.startsWith(prefix) ? text.slice(prefix.length) : text;
    });

    const tool = Effect.fn("Orogeny.Mcp.tool")(function* (input: typeof ToolInput.Type) {
      const result = yield* invoke<CallDetails>({
        server: input.server,
        tool: input.tool,
        args: input.args,
      });
      const raw = result.details.mcpResult;
      if (raw === undefined) {
        yield* reject(result);
        return { content: result.content, structuredContent: {} };
      }
      if (raw.isError === true) {
        const content = raw.content ?? result.content;
        return yield* failed(
          result.details.message ?? "The MCP tool failed.",
          content,
          // SAFETY: adapter detail records are JSON values by MCP contract.
          result.details as Schema.Json,
        );
      }
      const { isError: _, ...value } = raw;
      return value;
    });

    const authenticate = Effect.fn("Orogeny.Mcp.authenticate")(function* (server: string) {
      const active = yield* current;
      const command = yield* pipe(
        captured.command("mcp-auth"),
        Effect.mapError(() => failed("The embedded MCP adapter did not register authentication.")),
      );
      yield* Effect.tryPromise({
        // SAFETY: the adapter's mcp-auth handler uses only ExtensionContext fields.
        try: () => command.handler(server, active as ExtensionCommandContext),
        catch: (cause) =>
          cause instanceof Error && cause.name === "AbortError"
            ? new Aborted(cause.message)
            : failed(messageFrom(cause)),
      });
      const status = pipe(
        yield* list(),
        Arr.findFirst((item) => item.name === server),
      );
      if (Option.isSome(status) && status.value.status === "connected") return;
      return yield* failed(`MCP server ${JSON.stringify(server)} was not authenticated.`, [], {
        server,
        status: Option.isSome(status) ? status.value.status : "not-found",
      });
    });

    yield* bridge.register(
      "mcp.list",
      Effect.fn("Orogeny.Mcp.bridge.list")(() => list()),
    );
    yield* bridge.register(
      "mcp.search",
      Effect.fn("Orogeny.Mcp.bridge.search")(function* (input) {
        return yield* search(
          yield* pipe(
            decodeSearch(input),
            Effect.mapError((cause) => invalid("mcp.search(query, options?)", cause)),
          ),
        );
      }),
    );
    yield* bridge.register(
      "mcp.server.list",
      Effect.fn("Orogeny.Mcp.bridge.serverList")(function* (input) {
        const { server } = yield* pipe(
          decodeServer(input),
          Effect.mapError((cause) => invalid("mcp(<server>).list()", cause)),
        );
        return yield* serverList(server);
      }),
    );
    yield* bridge.register(
      "mcp.server.instructions",
      Effect.fn("Orogeny.Mcp.bridge.instructions")(function* (input) {
        const { server } = yield* pipe(
          decodeServer(input),
          Effect.mapError((cause) => invalid("mcp(<server>).instructions()", cause)),
        );
        return yield* instructions(server);
      }),
    );
    yield* bridge.register(
      "mcp.server.tool",
      Effect.fn("Orogeny.Mcp.bridge.tool")(function* (input) {
        return yield* tool(
          yield* pipe(
            decodeTool(input),
            Effect.mapError((cause) => invalid("mcp(<server>).tools(tool)(args?)", cause)),
          ),
        );
      }),
    );
    yield* bridge.register(
      "mcp.server.authenticate",
      Effect.fn("Orogeny.Mcp.bridge.authenticate")(function* (input) {
        const { server } = yield* pipe(
          decodeServer(input),
          Effect.mapError((cause) => invalid("mcp(<server>).authenticate()", cause)),
        );
        return yield* authenticate(server);
      }),
    );

    const open: Interface["open"] = Effect.fn("Orogeny.Mcp.open")(function* (active) {
      const config = yield* Effect.try({
        try: () => loadMcpConfig(undefined, active.cwd),
        catch: (cause) => failed(messageFrom(cause)),
      });
      const registrations = yield* Effect.forEach(
        Object.entries(config.mcpServers),
        ([name, definition]) =>
          Effect.try({
            try: () =>
              registerMcpServer({
                pi: captured.api,
                name,
                definition: normalizeServer(definition),
              }),
            catch: (cause) => failed(messageFrom(cause)),
          }),
      );
      yield* Ref.set(context, Option.some(active));
      yield* Effect.addFinalizer(() =>
        pipe(
          Effect.forEach(
            registrations,
            (registration) =>
              pipe(
                Effect.promise(() => registration.dispose()),
                Effect.ignore,
              ),
            { discard: true },
          ),
          Effect.andThen(Ref.set(context, Option.none())),
        ),
      );
    });

    return Service.of({ open });
  }),
);

export * as Capture from "./capture.ts";
export * as Prelude from "./prelude.ts";
export * as Mcp from "./index.ts";
