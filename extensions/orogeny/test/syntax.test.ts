import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { Chunk, Effect, HashMap, Layer, Option, pipe, Schema } from "effect";
import { Config } from "#o/config";
import { Syntax } from "#o/syntax";

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of(Schema.decodeUnknownSync(Config.schema)({})),
);
const syntaxLayer = pipe(Syntax.layer, Layer.provide(configLayer));
const rgb = (style: number) => style & 0x00ff_ffff;

const run = <A, E>(effect: Effect.Effect<A, E, Syntax.Service>) =>
  pipe(effect, Effect.provide(syntaxLayer), Effect.runPromise);

test("loads the generated native language catalog", async () => {
  const { languages, tags } = await run(Syntax.Service);
  assert.deepEqual(
    {
      ts: Option.getOrUndefined(HashMap.get(languages, "ts")),
      py: Option.getOrUndefined(HashMap.get(languages, "py")),
      odin: Option.getOrUndefined(HashMap.get(languages, "odin")),
      cSharp: Option.getOrUndefined(HashMap.get(tags, "$c_sharp")),
      appSrc: Option.getOrUndefined(HashMap.get(tags, "$app_src")),
    },
    {
      ts: "typescript",
      py: "python",
      odin: "odin",
      cSharp: "c_sharp",
      appSrc: "erlang",
    },
  );
});

test("settles an empty document without starting verification", async () => {
  const highlights = await run(
    Effect.gen(function* () {
      return yield* (yield* Syntax.Service).highlight("typescript", "");
    }),
  );
  assert.equal(Chunk.isEmpty(highlights), true);
});

test("streams append-only frames and rejects source replacement", async () => {
  const highlighter = await run(
    Effect.gen(function* () {
      return yield* (yield* Syntax.Service).highlighter("typescript");
    }),
  );
  const first = await Effect.runPromise(highlighter.updateFrame("const answer"));
  const second = await Effect.runPromise(highlighter.updateFrame("const answer = 42;"));

  assert.equal(first.startIndex, 0);
  assert.equal(second.endIndex, Buffer.byteLength("const answer = 42;"));
  await assert.rejects(
    Effect.runPromise(highlighter.updateFrame("let replacement = true;")),
    /append syntax source|Source is not append-only/,
  );
});

test("does not repaint syntax when verification confirms the speculative frame", async () => {
  const source = "const answer: number = 42;";
  const highlighter = await run(
    Effect.gen(function* () {
      return yield* (yield* Syntax.Service).highlighter("typescript");
    }),
  );
  const first = await Effect.runPromise(highlighter.updateFrame(source));
  const corrections: Array<Syntax.Frame> = [];
  let frame = first;

  for (let attempt = 0; frame.needsRender && attempt < 1_000; attempt++) {
    frame = await Effect.runPromise(highlighter.completeFrame());
    corrections.push(frame);
    if (frame.needsRender) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(frame.needsRender, false);
  assert.equal(corrections.every(({ startIndex, endIndex }) => startIndex === endIndex), true);
});

test("highlights a model-directed TypeScript fence before its closing backtick", async () => {
  const source = "$typescript`const answer: number = 42;";
  const highlighter = await run(
    Effect.gen(function* () {
      return yield* (yield* Syntax.Service).highlighter("typescript");
    }),
  );
  const frame = await Effect.runPromise(highlighter.updateFrame(source));
  const bytes = Buffer.from(source);

  assert.equal(
    Chunk.some(
      frame.highlights,
      ({ style, startIndex, endIndex }) =>
        rgb(style) === 0xfca7ea && bytes.subarray(startIndex, endIndex).toString() === "const",
    ),
    true,
  );
});

test("highlights open styled, HTML, and Markdown tags without closing backticks", async () => {
  const fixtures = [
    { source: "$styled`\n  :host { display: grid;", marker: "display", color: 0x4fd6be },
    { source: '$html`\n  <main class="card">', marker: "main", color: 0xc099ff },
    { source: "$markdown`\n  ## Streaming heading", marker: "Streaming", color: 0xffc777 },
  ] as const;
  const highlighted = await run(
    Effect.gen(function* () {
      const syntax = yield* Syntax.Service;
      return yield* Effect.forEach(fixtures, ({ source }) =>
        syntax.highlight("typescript", source),
      );
    }),
  );

  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index]!;
    const source = Buffer.from(fixture.source);
    const marker = Buffer.byteLength(
      fixture.source.slice(0, fixture.source.indexOf(fixture.marker)),
    );
    assert.equal(
      pipe(
        highlighted[index]!,
        Chunk.findFirst(
          ({ startIndex, endIndex }) => startIndex <= marker && endIndex > marker,
        ),
        Option.map(({ style }) => rgb(style)),
        Option.getOrUndefined,
      ),
      fixture.color,
      `${fixture.marker} was not highlighted before its closing backtick`,
    );
    assert.equal(source.includes(0x60, marker), false);
  }
});

test("keeps escaped TypeScript template delimiters inside one injection", async () => {
  const source = [
    "const source = $typescript`",
    "interface NotebookCell<TOutput> {",
    "  readonly id: \\`cell_\\${string}\\`;",
    '  readonly status: "queued" | "running" | "done";',
    "  readonly output?: TOutput;",
    "}",
  ].join("\n");
  const highlighter = await run(
    Effect.gen(function* () {
      return yield* (yield* Syntax.Service).highlighter("typescript");
    }),
  );
  const frame = await Effect.runPromise(highlighter.updateFrame(source));
  const bytes = Buffer.from(source);

  assert.equal(
    pipe(
      frame.highlights,
      Chunk.filter(
        ({ style, startIndex, endIndex }) =>
          rgb(style) === 0xfca7ea &&
          bytes.subarray(startIndex, endIndex).toString() === "readonly",
      ),
      Chunk.size,
    ),
    3,
  );
});

test("highlights language-tagged TypeScript templates", async () => {
  const source =
    'const shell = $sh`echo hi`; const script = $python`print("ok")`; $unknown`x`;';
  const highlights = await run(
    Effect.gen(function* () {
      return yield* (yield* Syntax.Service).highlight("ts", source);
    }),
  );
  const bytes = Buffer.from(source);
  const captured = Chunk.toReadonlyArray(highlights).map(({ style, startIndex, endIndex }) => [
    rgb(style),
    bytes.subarray(startIndex, endIndex).toString(),
  ]);

  assert.equal(captured.some(([color, text]) => color === 0x65bcff && text === "echo"), true);
  assert.equal(captured.some(([color, text]) => color === 0x65bcff && text === "print"), true);
});

test("composes visual styles beneath empty Neovim metadata captures", async () => {
  const [json, html] = await run(
    Effect.gen(function* () {
      const syntax = yield* Syntax.Service;
      return yield* Effect.all([
        syntax.highlight("json", '{"name":"orogeny"}'),
        syntax.highlight("html", '<main class="profile"></main>'),
      ]);
    }),
  );
  const styleAt = (highlights: Chunk.Chunk<Syntax.Highlight>, offset: number) =>
    pipe(
      highlights,
      Chunk.findFirst(({ startIndex, endIndex }) => startIndex <= offset && endIndex > offset),
      Option.map(({ style }) => rgb(style)),
      Option.getOrUndefined,
    );

  assert.equal(styleAt(json, 1), 0x4fd6be);
  assert.equal(styleAt(json, 8), 0xc3e88d);
  assert.equal(styleAt(html, 1), 0xc099ff);
  assert.equal(styleAt(html, 6), 0x4fd6be);
  assert.equal(styleAt(html, 13), 0xc3e88d);
});

test("recursively highlights injected languages", async () => {
  const source = '$html`<script>const answer = 42;</script>`';
  const highlights = await run(
    Effect.gen(function* () {
      const syntax = yield* Syntax.Service;
      return yield* syntax.highlight("typescript", source);
    }),
  );
  const bytes = Buffer.from(source);

  assert.equal(
    Chunk.some(
      highlights,
      ({ style, startIndex, endIndex }) =>
        rgb(style) === 0xfca7ea && bytes.subarray(startIndex, endIndex).toString() === "const",
    ),
    true,
  );
});

test("dedents model-directed Markdown before resolving fenced languages", async () => {
  const source = [
    "const sample = {",
    "  source: $markdown`",
    "      # Recursive injection report",
    "",
    "      Plain Markdown text.",
    "",
    "      ~~~typescript",
    "      const settled = true;",
    "      ~~~",
    "",
    "      ~~~bash",
    "      printf '%s\\\\n' ready",
    "      ~~~",
    "",
    "      ~~~sql",
    "      SELECT language FROM highlights;",
    "      ~~~",
    "    `,",
    "};",
  ].join("\n");
  const highlights = await run(
    Effect.gen(function* () {
      return yield* (yield* Syntax.Service).highlight("typescript", source);
    }),
  );
  const bytes = Buffer.from(source);
  const styleAt = (text: string) => {
    const start = Buffer.byteLength(source.slice(0, source.indexOf(text)));
    return pipe(
      highlights,
      Chunk.findFirst(({ startIndex, endIndex }) => startIndex <= start && endIndex > start),
      Option.map(({ style }) => rgb(style)),
      Option.getOrUndefined,
    );
  };

  assert.equal(styleAt("Recursive injection report"), 0x82aaff);
  assert.equal(styleAt("Plain Markdown text"), undefined);
  assert.equal(styleAt("const settled"), 0xfca7ea);
  assert.equal(styleAt("printf"), 0x65bcff);
  assert.equal(styleAt("SELECT language"), 0xfca7ea);
  assert.equal(
    Chunk.every(highlights, ({ startIndex, endIndex }) =>
      startIndex >= 0 && endIndex <= bytes.length
    ),
    true,
  );
});

test("combines and maps repeated language injections", async () => {
  const source = "$bash`echo one`; $bash`echo two`";
  const highlights = await run(
    Effect.gen(function* () {
      const syntax = yield* Syntax.Service;
      return yield* syntax.highlight("typescript", source);
    }),
  );
  const bytes = Buffer.from(source);

  assert.equal(
    pipe(
      highlights,
      Chunk.filter(
        ({ style, startIndex, endIndex }) =>
          rgb(style) === 0x65bcff && bytes.subarray(startIndex, endIndex).toString() === "echo",
      ),
      Chunk.size,
    ),
    2,
  );
});

