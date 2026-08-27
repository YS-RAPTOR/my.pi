import { Effect, Layer } from "effect";
import { Bridge } from "#o/bridge";
import { Prelude } from "#o/prelude";

const source = Prelude.dedent`
  const pi = (() => {
    const imageBlob = (data: string, mimeType: string): Blob => {
      const binary = atob(data);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new Blob([bytes], { type: mimeType });
    };

    return Object.freeze({
      applyPatch: async (patch: string): Promise<void> => {
        await ${Bridge.Bootstrap.CALLABLE}<unknown>("pi.applyPatch", patch);
      },
      bash: (input: {
        command: string;
        timeout?: number;
      }): Promise<{
        text: string;
        truncated: boolean;
        outputPath: string | null;
      }> => ${Bridge.Bootstrap.CALLABLE}<{
        text: string;
        truncated: boolean;
        outputPath: string | null;
      }>("pi.bash", input),
      find: (input: {
        pattern: string;
        path?: string;
        exclude?: string[];
        limit?: number;
        cursor?: string;
      }): Promise<{
        paths: string[];
        cursor: string | null;
      }> => ${Bridge.Bootstrap.CALLABLE}<{
        paths: string[];
        cursor: string | null;
      }>("pi.find", input),
      grep: (input: {
        pattern: string;
        path?: string;
        exclude?: string[];
        caseSensitive?: boolean;
        context?: number;
        limit?: number;
        cursor?: string;
      }): Promise<{
        matches: {
          path: string;
          line: number;
          status: string | null;
          match: string;
          text: string;
        }[];
        fuzzy: boolean;
        cursor: string | null;
      }> => ${Bridge.Bootstrap.CALLABLE}<{
        matches: {
          path: string;
          line: number;
          status: string | null;
          match: string;
          text: string;
        }[];
        fuzzy: boolean;
        cursor: string | null;
      }>("pi.grep", input),
      read: async (input: {
        path: string;
        offset?: number;
        limit?: number;
      }): Promise<{
        text: string;
        truncated: boolean;
        image: Blob | null;
      }> => {
        const result = await ${Bridge.Bootstrap.CALLABLE}<{
          text: string;
          truncated: boolean;
          image: {
            data: string;
            mimeType: string;
          } | null;
        }>("pi.read", input);
        return {
          text: result.text,
          truncated: result.truncated,
          image: result.image === null
            ? null
            : imageBlob(result.image.data, result.image.mimeType),
        };
      },
    });
  })();
`;

const docs: ReadonlyArray<Prelude.Doc> = [
  {
    name: "pi",
    kind: "namespace",
    summary: "Approved one-shot Pi capabilities.",
    signature: Prelude.dedent`
      const pi: Readonly<{
        applyPatch(patch: string): Promise<void>;
        bash(input: {
          command: string;
          timeout?: number;
        }): Promise<{
          text: string;
          truncated: boolean;
          outputPath: string | null;
        }>;
        find(input: {
          pattern: string;
          path?: string;
          exclude?: string[];
          limit?: number;
          cursor?: string;
        }): Promise<{
          paths: string[];
          cursor: string | null;
        }>;
        grep(input: {
          pattern: string;
          path?: string;
          exclude?: string[];
          caseSensitive?: boolean;
          context?: number;
          limit?: number;
          cursor?: string;
        }): Promise<{
          matches: {
            path: string;
            line: number;
            status: string | null;
            match: string;
            text: string;
          }[];
          fuzzy: boolean;
          cursor: string | null;
        }>;
        read(input: {
          path: string;
          offset?: number;
          limit?: number;
        }): Promise<{
          text: string;
          truncated: boolean;
          image: Blob | null;
        }>;
      }>
    `,
    description: Prelude.singleLine`
      The namespace for approved one-shot host operations exposed inside notebooks.
    `,
    errors: [],
    examples: ["Object.keys(pi)", '$docs.filter((doc) => doc.name.startsWith("pi."))'],
    keywords: ["pi", "host", "tools", "namespace"],
  },
  {
    name: "pi.applyPatch",
    kind: "function",
    summary: "Apply a Codex patch.",
    signature: Prelude.dedent`
      pi.applyPatch(
        // A freeform Codex patch. Starts with \`*** Begin Patch\`, ends with \`*** End
        // Patch\`, and contains one or more file hunks:
        // - \`*** Add File: <path>\` followed by one or more \`+<line>\` entries.
        // - \`*** Delete File: <path>\`.
        // - \`*** Update File: <path>\`, optionally followed by \`*** Move to: <path>\`,
        //   then \`@@\` or \`@@ <context>\` sections containing unchanged \` <line>\`,
        //   removed \`-<line>\`, added \`+<line>\`, and optionally \`*** End of File\`.
        patch: string,
      ): Promise<void>
    `,
    description: Prelude.singleLine`
      The \`apply_patch\` tool can be used to edit files. This is a FREEFORM tool, so do
      not wrap the patch in \`JSON\`.
    `,
    errors: [
      "Throws when the patch is invalid or cannot be applied.",
      "Throws on filesystem or host failure. Earlier changes may remain committed after a partial failure, and the error reports their known paths.",
    ],
    examples: [
      Prelude.dedent`
        await pi.applyPatch($patch\`
          *** Begin Patch
          *** Update File: src/index.ts
          @@
          -const enabled = false;
          +const enabled = true;
          *** End Patch
        \`)
      `,
    ],
    keywords: ["apply", "patch", "edit", "write", "file", "codex"],
  },
  {
    name: "pi.bash",
    kind: "function",
    summary: "Execute one shell command.",
    signature: Prelude.dedent`
      pi.bash(input: {
        // Bash command to execute
        command: string;
        // Timeout in seconds (optional, no default timeout)
        timeout?: number;
      }): Promise<{
        // Complete \`stdout\` and \`stderr\`, or their retained tail when truncated.
        text: string;
        // Whether output exceeded Pi's line or byte limit.
        truncated: boolean;
        // Path containing the complete output when truncated, otherwise \`null\`.
        outputPath: string | null;
      }>
    `,
    description: Prelude.singleLine`
      Execute a bash command in the current working directory. Returns \`stdout\` and
      \`stderr\`. Output is truncated to the last 2000 lines or 50KB (whichever is hit
      first). If \`truncated\`, full output is saved to a temp file. Optionally provide a
      timeout in seconds.
    `,
    errors: [
      "Throws when arguments are invalid.",
      "Throws when the command exits with a non-zero status.",
      "Throws on timeout, cancellation, or host failure.",
    ],
    examples: [
      "await pi.bash({ command: $sh`git status` })",
      "await pi.bash({ command: $sh`npm test`, timeout: 120 })",
      Prelude.dedent`
        await pi.bash({
          command: $sh\`
            set -e
            npm run typecheck
            npm test
          \`,
        })
      `,
    ],
    keywords: ["bash", "command", "process", "shell", "terminal"],
  },
  {
    name: "pi.find",
    kind: "function",
    summary: "Find files by fuzzy path or glob.",
    signature: Prelude.dedent`
      pi.find(input: {
        // Fuzzy filename search and glob search. Frecency-ranked, git-aware.
        // Multi-word = narrower (AND) not bound to order, use for multi word related
        // concept search. Prefer this over \`ls\`/\`find\`/\`bash\` as the first exploration
        // step whenever the user names a concept, feature, or symbol — it surfaces the
        // relevant files in one call. Only use \`ls\`/\`read\` on a directory when you
        // specifically need the alphabetical layout of an unknown repo, or when a
        // concept search returned nothing.
        pattern: string;
        // Path constraint. Directory prefix (\`src/\` or \`src/foo/\`), bare filename with
        // extension (\`main.rs\`), or glob (\`*.ts\`, \`src/**/*.cc\`, \`{src,lib}/**\`).
        // Applied to the full repo-relative path. Absolute, \`~/\`, and \`../\` paths
        // outside the workspace are also supported and searched with a separate index.
        path?: string;
        // Exclude paths. Each entry uses the same syntax as \`path\`: directory prefix
        // (\`test/\`), filename with extension (\`config.json\`), or glob (\`*.min.js\`,
        // \`**/*.{rs,go}\`). A leading \`!\` is optional and ignored.
        exclude?: string[];
        // Max results per page (default 30)
        limit?: number;
        // Pagination cursor from previous result
        cursor?: string;
      }): Promise<{
        // Matched paths in frecency-ranked order.
        paths: string[];
        // Pagination cursor for the next page, or \`null\` when no more matches remain.
        cursor: string | null;
      }>
    `,
    description: Prelude.singleLine`
      Fuzzy path search and glob search. Matches against the whole repo-relative path, not
      just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default
      limit 30.
    `,
    errors: [
      "Throws when arguments or the pagination cursor are invalid.",
      "Throws when search indexing is unavailable or the host operation fails.",
    ],
    examples: [
      'await pi.find({ pattern: "profile" })',
      'await pi.find({ pattern: "profile **/*.{ts,tsx}", exclude: ["**/*.test.*"] })',
      'await pi.find({ pattern: "", path: "src/**", exclude: ["test/", "*.min.js"] })',
      Prelude.dedent`
        const pattern = "profile"
        let page = await pi.find({ pattern, limit: 20 })
        const paths = [...page.paths]

        while (page.cursor !== null) {
          page = await pi.find({ pattern, cursor: page.cursor })
          paths.push(...page.paths)
        }
      `,
    ],
    keywords: ["find", "file", "path", "fuzzy", "glob", "frecency", "git"],
  },
  {
    name: "pi.grep",
    kind: "function",
    summary: "Search file contents.",
    signature: Prelude.dedent`
      pi.grep(input: {
        // Search pattern (literal text or regex)
        pattern: string;
        // Path constraint. Directory prefix (\`src/\` or \`src/foo/\`), bare filename with
        // extension (\`main.rs\`), or glob (\`*.ts\`, \`src/**/*.cc\`, \`{src,lib}/**\`).
        // Applied to the full repo-relative path. Absolute, \`~/\`, and \`../\` paths
        // outside the workspace are also supported and searched with a separate index.
        path?: string;
        // Exclude paths. Each entry uses the same syntax as \`path\`: directory prefix
        // (\`test/\`), filename with extension (\`config.json\`), or glob (\`*.min.js\`,
        // \`**/*.{rs,go}\`). A leading \`!\` is optional and ignored.
        exclude?: string[];
        // Force case-sensitive matching. Default uses smart-case (case-insensitive when
        // pattern is all lowercase).
        caseSensitive?: boolean;
        // Context lines before+after each match
        context?: number;
        // Max matches (default 20)
        limit?: number;
        // Pagination cursor from previous result
        cursor?: string;
      }): Promise<{
        // Matches grouped by frecency-ranked file order and source order within each file.
        matches: {
          // Path containing the match.
          path: string;
          // 1-based line number of the match.
          line: number;
          // FFF's selected Git or frecency annotation without brackets, or \`null\`.
          status: string | null;
          // Matched source line as returned by FFF.
          match: string;
          // Context before, matched line, and context after joined with newlines without
          // added formatting.
          text: string;
        }[];
        // Whether approximate matches were returned after no exact literal matches.
        fuzzy: boolean;
        // Pagination cursor for the next page, or \`null\` when no more matches remain.
        cursor: string | null;
      }>
    `,
    description: Prelude.singleLine`
      Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are
      ranked by frecency (most-accessed files first); matches within a file stay in source
      order. Default limit 20.
    `,
    errors: [
      "Throws when arguments or the pagination cursor are invalid.",
      "Throws when the pattern matches everything instead of searching for concrete text.",
      "Throws when search indexing is unavailable or the host operation fails.",
    ],
    examples: [
      'await pi.grep({ pattern: "createServer" })',
      Prelude.dedent`
        await pi.grep({
          pattern: $regex\`create(Server|Client)\`,
          path: "src/",
          exclude: ["test/", "*.min.js"],
          caseSensitive: true,
          context: 2,
        })
      `,
    ],
    keywords: ["grep", "search", "content", "text", "regex", "literal", "fuzzy"],
  },
  {
    name: "pi.read",
    kind: "function",
    summary: "Read a text file or image.",
    signature: Prelude.dedent`
      pi.read(input: {
        // Path to the file to read (relative or absolute)
        path: string;
        // Line number to start reading from (1-indexed)
        offset?: number;
        // Maximum number of lines to read
        limit?: number;
      }): Promise<{
        // File contents for text files; an informational message for images.
        text: string;
        // Whether text exceeded Pi's line or byte limit.
        truncated: boolean;
        // Image \`Blob\` for a supported image file, otherwise \`null\`.
        image: Blob | null;
      }>
    `,
    description: Prelude.singleLine`
      Read the contents of a file. Supports text files and images (\`jpg\`, \`png\`, \`gif\`,
      \`webp\`, \`bmp\`). Images are returned as \`Blob\` values and can be displayed with
      \`$img.display\`. For text files, output is truncated to 2000 lines or 50KB
      (whichever is hit first). Use \`offset\`/\`limit\` for large files. When you need the
      full file, continue with \`offset\` until complete.
    `,
    errors: [
      "Throws when arguments are invalid.",
      "Throws when the path is missing, unreadable, or not a file.",
      "Throws when offset is beyond the end of the file.",
      "Throws on cancellation or host failure.",
    ],
    examples: [
      'await pi.read({ path: "src/index.ts" })',
      'await pi.read({ path: "src/index.ts", offset: 2001 })',
      Prelude.dedent`
        const result = await pi.read({ path: "screenshot.png" })
        if (result.image) await $img.display(result.image)
      `,
    ],
    keywords: ["read", "file", "text", "image", "blob", "contents"],
  },
];

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const preludes = yield* Prelude.Service;
    yield* preludes.register({ name: "pi", source, docs });
  }),
);
