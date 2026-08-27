import { Effect, Layer } from "effect";
import { Bridge } from "#o/bridge";
import { Prelude } from "#o/prelude";

const source = Prelude.dedent`
  const mcp = (() => {
    class MCPError extends Error {
      readonly content: readonly unknown[];
      readonly details: Readonly<Record<string, unknown>>;

      constructor(
        message: string,
        content: readonly unknown[] = [],
        details: Readonly<Record<string, unknown>> = {},
      ) {
        super(message);
        this.name = "MCPError";
        this.content = content;
        this.details = details;
      }
    }

    const call = async <Value>(operation: string, input: unknown = null): Promise<Value> => {
      try {
        return await ${Bridge.Bootstrap.CALLABLE}<Value>(operation, input);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "MCPError") throw error;
        const data = (error as Error & {
          data?: {
            message?: string;
            content?: unknown[];
            details?: Record<string, unknown>;
          };
        }).data;
        throw new MCPError(
          data?.message ?? error.message,
          data?.content ?? [],
          data?.details ?? {},
        );
      }
    };

    const server = (server: string) => {
      if (server.trim() === "") throw new TypeError("MCP server name must not be empty");

      return Object.freeze({
        list: (): Promise<{
          tool: string;
          description: string;
          inputSchema?: unknown;
        }[]> => call("mcp.server.list", { server }),
        instructions: (): Promise<string | null> =>
          call("mcp.server.instructions", { server }),
        tools: (tool: string) => {
          if (tool.trim() === "") throw new TypeError("MCP tool name must not be empty");
          return (args: Record<string, unknown> = {}): Promise<{
            content: unknown[];
            structuredContent?: Record<string, unknown>;
            _meta?: Record<string, unknown>;
          }> => call("mcp.server.tool", { server, tool, args });
        },
        authenticate: (): Promise<void> => call("mcp.server.authenticate", { server }),
      });
    };

    return Object.freeze(Object.assign(server, {
      Error: MCPError,
      list: (): Promise<{
        name: string;
        status: | "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";
        toolCount: number;
        failedAgoSeconds?: number;
      }[]> => call("mcp.list"),
      search: (
        query: string,
        options: {
          server?: string;
          regex?: boolean;
          limit?: number;
          offset?: number;
        } = {},
      ): Promise<{
        items: {
          server: string;
          tool: string;
          description: string;
          inputSchema?: unknown;
        }[];
        nextOffset: number | null;
      }> => call("mcp.search", { ...options, query }),
    }));
  })();
`;

const docs: ReadonlyArray<Prelude.Doc> = [
  {
    name: "mcp",
    kind: "function",
    summary: "Select a dynamically configured MCP server.",
    signature: Prelude.dedent`
      mcp(
        // Configured MCP server name.
        server: string,
      ): Readonly<{
        list(): Promise<{
          tool: string;
          description: string;
          inputSchema?: unknown;
        }[]>;
        instructions(): Promise<string | null>;
        tools(tool: string): (
          args?: Record<string, unknown>,
        ) => Promise<{
          content: unknown[];
          structuredContent?: Record<string, unknown>;
          _meta?: Record<string, unknown>;
        }>;
        authenticate(): Promise<void>;
      }>
    `,
    description: Prelude.singleLine`
      \`mcp(<server>)\` returns a lightweight handle to the configured MCP server named by
      \`server\`. Creating the handle does not contact the server; calling one of its
      methods performs the requested operation.
    `,
    errors: ["Throws when the server name is empty."],
    examples: ['const linear = mcp("linear-server")'],
    keywords: ["mcp", "server", "select", "handle", "dynamic", "tools"],
  },
  {
    name: "mcp.list",
    kind: "function",
    summary: "List configured MCP servers and their current status.",
    signature: Prelude.dedent`
      mcp.list(): Promise<{
        // Configured server name.
        name: string;
        // Current connection or availability state.
        status: | "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";
        // Number of tools currently known for the server.
        toolCount: number;
        // Seconds since the connection failed. Present only when \`status\` is \`"failed"\`.
        failedAgoSeconds?: number;
      }[]>
    `,
    description: Prelude.singleLine`
      \`mcp.list()\` returns one entry for every currently configured MCP server. \`status\`
      distinguishes live connections, cached metadata, connection failures, authentication
      requirements, servers that have not connected, and disabled servers.
    `,
    errors: ["Throws when MCP server status cannot be read."],
    examples: [
      "const servers = await mcp.list()",
      Prelude.dedent`
        const connected = (await mcp.list())
          .filter(({ status }) => status === "connected")
      `,
    ],
    keywords: ["mcp", "list", "servers", "status", "connection", "authentication"],
  },
  {
    name: "mcp.search",
    kind: "function",
    summary: "Search tools across configured MCP servers.",
    signature: Prelude.dedent`
      mcp.search(
        // Tool name or description query.
        query: string,
        options?: {
          // Restrict results to one configured server.
          server?: string;
          // Treat \`query\` as a regular expression instead of ranked text.
          regex?: boolean;
          // Maximum number of results to return.
          limit?: number;
          // Zero-based result offset used for pagination.
          offset?: number;
        },
      ): Promise<{
        // Matching tools in relevance order.
        items: {
          // Configured server name.
          server: string;
          // Original tool name advertised by the server.
          tool: string;
          // Tool description.
          description: string;
          // Advertised input JSON Schema, when available.
          inputSchema?: unknown;
        }[];
        // Offset for the next page, or \`null\` when this is the final page.
        nextOffset: number | null;
      }>
    `,
    description: Prelude.singleLine`
      \`mcp.search()\` searches known MCP tool names and descriptions across configured
      servers while preserving relevance order. Use \`server\` to search one server,
      \`regex\` for regular-expression matching, and \`nextOffset\` to continue to the next
      page. An empty query returns an empty result. Searching discovers tools but does not
      invoke them.
    `,
    errors: [
      "Throws when the query or options are invalid.",
      "Throws when the search cannot be completed.",
    ],
    examples: [
      'const matches = await mcp.search("issues")',
      Prelude.dedent`
        const matches = await mcp.search($regex\`^(search|list)_\`, {
          server: "linear-server",
          regex: true,
          limit: 20,
        })
      `,
      Prelude.dedent`
        const query = "issues"
        const options = { server: "linear-server", limit: 20 }
        let page = await mcp.search(query, options)
        const tools = [...page.items]

        while (page.nextOffset !== null) {
          page = await mcp.search(query, {
            ...options,
            offset: page.nextOffset,
          })
          tools.push(...page.items)
        }
      `,
    ],
    keywords: ["mcp", "search", "tools", "servers", "regex", "schema", "pagination"],
  },
  {
    name: "mcp(<server>).list",
    kind: "method",
    summary: "List tools provided by one MCP server.",
    signature: Prelude.dedent`
      mcp(<server>).list(): Promise<{
        // Original tool name advertised by the server.
        tool: string;
        // Tool description.
        description: string;
        // Advertised input JSON Schema, when available.
        inputSchema?: unknown;
      }[]>
    `,
    description: Prelude.singleLine`
      \`mcp(<server>).list()\` returns the tools advertised by the selected server. Tool names
      are returned unchanged, and a server without tools returns an empty array.
    `,
    errors: [
      "Throws when the server is unknown, disabled, unavailable, or requires authentication.",
      "Throws when the server's tools cannot be listed.",
    ],
    examples: [
      'const tools = await mcp("linear-server").list()',
      Prelude.dedent`
        const tools = await mcp("linear-server").list()
        const search = tools.find(({ tool }) => tool === "search_issues")
      `,
    ],
    keywords: ["mcp", "server", "list", "tools", "description", "schema"],
  },
  {
    name: "mcp(<server>).instructions",
    kind: "method",
    summary: "Read usage instructions provided by one MCP server.",
    signature: Prelude.dedent`
      mcp(<server>).instructions(): Promise<
        // Instruction text, or \`null\` when the server provides none.
        string | null
      >
    `,
    description: Prelude.singleLine`
      \`mcp(<server>).instructions()\` returns the selected server's instruction text, or
      \`null\` when the server does not provide instructions.
    `,
    errors: [
      "Throws when the server is unknown, disabled, unavailable, or requires authentication.",
      "Throws when the server cannot connect or its instructions cannot be read.",
    ],
    examples: [
      'const instructions = await mcp("linear-server").instructions()',
      Prelude.dedent`
        const instructions = await mcp("linear-server").instructions()
        if (instructions !== null) console.log(instructions)
      `,
    ],
    keywords: ["mcp", "server", "instructions", "usage", "guidance"],
  },
  {
    name: "mcp(<server>).tools",
    kind: "method",
    summary: "Select and invoke a tool provided by one MCP server.",
    signature: Prelude.dedent`
      mcp(<server>).tools(
        // Original tool name advertised by the selected server.
        tool: string,
      )(
        // Arguments accepted by the tool's advertised input schema. Omit for a tool
        // without arguments; an empty object is sent.
        args?: Record<string, unknown>,
      ): Promise<{
        // MCP content blocks returned by the tool.
        content: unknown[];
        // Structured result returned by the tool, when provided.
        structuredContent?: Record<string, unknown>;
        // Additional MCP result metadata, when provided.
        _meta?: Record<string, unknown>;
      }>
    `,
    description: Prelude.singleLine`
      \`mcp(<server>).tools(tool)\` selects a tool by its original advertised name and
      returns the function that invokes it. Call that function with the tool's arguments,
      or with no argument when the tool accepts none.
    `,
    errors: [
      "Throws when the tool name is empty.",
      "Throws when the server or tool is unavailable or requires authentication.",
      "Throws `mcp.Error` when the MCP server reports a tool failure.",
      "Throws `AbortError` when the invocation is cancelled.",
    ],
    examples: [
      Prelude.dedent`
        const result = await mcp("linear-server")
          .tools("search_issues")({ query: "bug" })
      `,
      'const result = await mcp("time-server").tools("current_time")()',
    ],
    keywords: ["mcp", "server", "tools", "call", "invoke", "arguments", "result"],
  },
  {
    name: "mcp(<server>).authenticate",
    kind: "method",
    summary: "Authenticate one MCP server interactively.",
    signature: "mcp(<server>).authenticate(): Promise<void>",
    description: Prelude.singleLine`
      \`mcp(<server>).authenticate()\` opens the selected server's interactive
      authentication flow and waits for it to finish. It resolves once the server is ready
      to use.
    `,
    errors: ["Throws `mcp.Error` when the server cannot be authenticated or made ready to use."],
    examples: [
      'await mcp("linear-server").authenticate()',
      Prelude.dedent`
        const linear = mcp("linear-server")
        await linear.authenticate()
        const tools = await linear.list()
      `,
    ],
    keywords: ["mcp", "server", "authenticate", "authentication", "oauth", "interactive"],
  },
  {
    name: "mcp.Error",
    kind: "class",
    summary: "A structured failure from an MCP operation.",
    signature: Prelude.dedent`
      new mcp.Error(
        // Human-readable failure message.
        message: string,
        // MCP content blocks associated with the failure.
        content?: readonly unknown[],
        // Additional structured failure details.
        details?: Readonly<Record<string, unknown>>,
      ): Error & {
        readonly content: readonly unknown[];
        readonly details: Readonly<Record<string, unknown>>;
      }
    `,
    description: Prelude.singleLine`
      MCP operation failures throw \`mcp.Error\`. It preserves a readable \`message\`, any
      associated MCP \`content\`, and structured \`details\`. Use \`instanceof mcp.Error\`
      to distinguish it from ordinary JavaScript errors. Cancellation throws \`AbortError\`
      instead.
    `,
    errors: [],
    examples: [
      Prelude.dedent`
        try {
          await mcp("linear-server").tools("search_issues")({ query: "bug" })
        } catch (error) {
          if (!(error instanceof mcp.Error)) throw error
          console.error(error.message)
          console.log(error.content, error.details)
        }
      `,
    ],
    keywords: ["mcp", "error", "failure", "content", "details", "instanceof", "abort"],
  },
];

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const preludes = yield* Prelude.Service;
    yield* preludes.register({ name: "mcp", source, docs });
  }),
);
