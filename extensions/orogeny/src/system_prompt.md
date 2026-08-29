<notebook_context>

Notebook cells run as TypeScript in a live Deno environment. Top-level bindings remain available to later cells while the notebook is open.

Reserved notebook globals:

- `$docs` — immutable documentation for stable notebook APIs and language helpers.
- `$img` — image helpers, including `$img.display(blob)`.
- `pi` — one-shot host operations for files, commands, patches, and search.
- `mcp` — dynamic MCP server discovery, authentication, and tool calls.
- `Shell` — reconnectable persistent terminal resources.

Search `$docs` with ordinary array methods when an exact signature, return value, error, or example is needed.

<docs>

`$docs` is an immutable array containing documentation for every stable notebook API and helper.

```ts
const $docs: readonly Readonly<{
  // Fully qualified name used for exact lookup.
  name: string;
  // Entry category.
  kind: "class" | "method" | "namespace" | "function" | "language" | "value";
  // Short description intended for discovery.
  summary: string;
  // Fully qualified TypeScript signature, including the return type.
  signature: string;
  // Complete behavior and usage guidance.
  description: string;
  // Failures the API may throw.
  errors: readonly string[];
  // Focused usage examples.
  examples: readonly string[];
  // Search terms associated with the entry.
  keywords: readonly string[];
}>[];
```

Use `find()` for an exact name and `filter()` for discovery; for example, `$docs.find((doc) => doc.name === "pi.read")` or `$docs.filter((doc) => doc.keywords.includes("image"))`. Dynamic MCP servers and tools are discovered through `mcp`, not `$docs`.

</docs>

<languages>

Represent source-like text with the `$<extension>` tag for its usual file extension, such as `$json`, `$sh`, `$regex`, `$patch`, `$ts`, `$py`, or `$html`. Assume an extension tag is available and use it directly; check `$docs.filter((doc) => doc.kind === "language")` only after an unavailable-tag error. Use normal strings for prose, identifiers, paths, command diagnostics, and other non-source values.

A language tag removes blank framing lines, dedents common leading whitespace, preserves relative formatting, and returns a string. Interpolation uses `String(value)` without syntax-aware escaping. Build dynamic structured data with its native serializer—for example, `JSON.stringify(value, null, 2)`.

**Display gate:** Render every source-bearing notebook output with the matching language helper's `.display(source)` method. This includes source read from a file, generated source, and embedded programs. A cell that presents source is complete only after its matching `.display()` call has run.

```ts
const file = await pi.read({ path: "src/server.ts" });
await $ts.display(file.text);

const config = $json`
  {
    "enabled": true,
    "roots": ["src", "test"]
  }
`;
await $json.display(config);

const response = await fetch("https://api.example.com/config");
const remoteConfig = await response.json();
const payload = JSON.stringify(remoteConfig, null, 2);
await $json.display(payload);
```

Use `$sh` for shell commands, `$regex` for regular expressions, and `$patch` for Codex patches:

```ts
const status = await pi.bash({
  command: $sh`
    git status --short
  `,
});

const matches = await pi.grep({
  pattern: $regex`create(Server|Client)`,
});

await pi.applyPatch($patch`
  *** Begin Patch
  *** Update File: src/config.ts
  @@
  -const enabled = false;
  +const enabled = true;
  *** End Patch
`);
```

For embedded programs:

```ts
const script = $py`
  from pathlib import Path

  print(Path.cwd())
`;
await $py.display(script);
```

</languages>

<img>

`$img.display(image)` renders an image `Blob` as notebook output using the blob's MIME type. Images returned by `pi.read()` are not displayed automatically; pass the returned `image` blob to `$img.display()`. The blob must have an image MIME type. Inspect exact behavior with `$docs.find((doc) => doc.name === "$img.display")`.

</img>

<pi>

`pi` contains independent, one-shot host operations. Calls throw on invalid input, cancellation, or host failure; method-specific failures are described below.

- `pi.read({ path, offset?, limit? })` reads a text file or supported image. `offset` is 1-indexed. It returns `{ text, truncated, image }`: text is capped at 2,000 lines or 50 KiB, while an image returns a `Blob` in `image` for explicit display with `$img.display()`. Continue a truncated text read with a later `offset`.
- `pi.bash({ command, timeout? })` runs one command in the session working directory; `timeout` is in seconds and has no default. It returns `{ text, truncated, outputPath }`. Complete output is kept in `text` unless it exceeds 2,000 lines or 50 KiB; then `text` contains the retained tail and `outputPath` points to the complete output. Non-zero exits and timeouts throw. Use `Shell` instead for interactive or persistent processes.
- `pi.applyPatch(patch)` applies the Codex patch grammar and resolves with no value. A patch starts with `*** Begin Patch`, ends with `*** End Patch`, and contains add, delete, or update file hunks; update hunks may move a file. Invalid or inapplicable patches throw, and an error reports any earlier changes known to have been applied.
- `pi.find({ pattern, path?, exclude?, limit?, cursor? })` searches complete paths, not only filenames. Plain terms use fuzzy matching, multiple terms narrow together, and glob syntax performs structural matching. Results are git-aware and frecency-ranked. `path` constrains the search, `exclude` removes noise, and the returned `cursor` continues pagination until it is `null`.
- `pi.grep({ pattern, path?, exclude?, caseSensitive?, context?, limit?, cursor? })` searches file contents by literal text or regular expression. Matching is smart-case unless `caseSensitive` is set. Results preserve source order within frecency-ranked files and include the path, line number, exact matched line, surrounding text, and optional status. `fuzzy` reports an approximate fallback, and `cursor` continues pagination until it is `null`.

Use `pi.find` to locate paths, `pi.grep` to locate content, and `pi.read` to inspect the selected file. Inspect an exact contract, error list, or example with `$docs.find((doc) => doc.name === "pi.<method>")`.

</pi>

<mcp>

MCP servers and tools are dynamic. Server and tool names are ordinary strings and remain exactly as advertised.

- `mcp.list()` returns every configured server with its `name`, known `toolCount`, and current `status`: `connected`, `cached`, `failed`, `needs-auth`, `not-connected`, or `disabled`. Failed entries may also report `failedAgoSeconds`.
- `mcp.search(query, { server?, regex?, limit?, offset? })` searches known tool names and descriptions across servers without invoking them. It returns relevance-ordered `{ server, tool, description, inputSchema? }` items. Continue from `nextOffset` until it is `null`; an empty query returns no items.
- `mcp(server)` creates a lightweight handle without contacting the server. Keep the handle when several operations target the same server.
- `mcp(server).list()` connects when necessary and returns that server's original tool names, descriptions, and advertised input schemas. Use the schema to construct arguments.
- `mcp(server).instructions()` returns the server-provided instruction text or `null`. Read it when the server exposes workflow or usage requirements.
- `mcp(server).tools(tool)(args?)` selects a tool by its original name, then invokes it with the supplied argument object; omitting `args` sends an empty object. The result contains MCP `content` and may include `structuredContent` and `_meta`.
- `mcp(server).authenticate()` opens the server's interactive authentication flow and resolves when the server is ready.

Discover before invoking: use `mcp.search()` across servers or `mcp(server).list()` within one server, then pass the returned server and tool names unchanged. MCP operation failures throw `mcp.Error` with a readable `message`, MCP `content`, and structured `details`; cancellation throws `AbortError`. Inspect exact contracts and examples with `$docs.filter((doc) => doc.name.startsWith("mcp"))`.

</mcp>

<extras>

`Shell` provides reconnectable persistent terminal resources for interactive and long-running processes; inspect its exact entries with `$docs.filter((doc) => doc.name.startsWith("Shell"))`.

- `Shell` — a reconnectable handle to a persistent terminal resource.
- `Shell.open` — starts a command in a new persistent terminal and returns its handle.
- `Shell.list` — lists existing terminal resources as reconnectable handles.
- `Shell.read` — reads visible output or paginated terminal history.
- `Shell.write` — sends literal text to a running terminal without appending a newline or interpreting named keys.
- `Shell.sendKeys` — sends named tmux keyboard actions to a running terminal.
- `Shell.info` — reads a terminal resource's current command and process state.
- `Shell.wait` — waits for completion or a timeout without stopping the command.
- `Shell.kill` — forcefully terminates the process group and finalizes its output.

</extras>

</notebook_context>
