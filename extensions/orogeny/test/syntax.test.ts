import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { Chunk, Effect, Layer, Option, pipe, Schema } from "effect";
import { Config } from "#o/config";
import { Syntax } from "#o/syntax";
import { composeHighlights, composeInjections } from "../src/syntax/source.ts";

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of(Schema.decodeUnknownSync(Config.schema)({})),
);
const syntaxLayer = pipe(Syntax.layer, Layer.provide(configLayer));

const run = <A, E>(effect: Effect.Effect<A, E, Syntax.Service>) =>
  pipe(effect, Effect.provide(syntaxLayer), Effect.runPromise);

test("composes missing query inheritance", () => {
  const source = (language: string) => language;
  const highlights = (language: string) =>
    Option.getOrThrow(composeHighlights(language, source));
  const injections = (language: string) =>
    Option.getOrThrow(composeInjections(language, source));

  assert.deepEqual(
    {
      arduino: highlights("arduino"),
      hlsl: highlights("hlsl"),
      qmljs: highlights("qmljs"),
      slang: highlights("slang"),
      typescript: highlights("typescript"),
      fsharpSignature: injections("fsharp_signature"),
      qmljsInjections: injections("qmljs"),
    },
    {
      arduino: "c\ncpp\narduino",
      hlsl: "c\ncpp\nhlsl",
      qmljs: "javascript\ntypescript\nqmljs",
      slang: "c\nslang",
      typescript: "javascript\ntypescript",
      fsharpSignature: "fsharp\nfsharp_signature",
      qmljsInjections: "javascript\nqmljs",
    },
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
  const captured = Chunk.toReadonlyArray(highlights).map(({ name, startIndex, endIndex }) => [
    name,
    bytes.subarray(startIndex, endIndex).toString(),
  ]);

  assert.equal(
    captured.some(([name, text]) => name === "function" && text === "echo"),
    true,
  );
  assert.equal(
    captured.some(([name, text]) => name === "function.builtin" && text === "print"),
    true,
  );
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
      ({ name, startIndex, endIndex }) =>
        name === "keyword" && bytes.subarray(startIndex, endIndex).toString() === "const",
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
        ({ name, startIndex, endIndex }) =>
          name === "function" && bytes.subarray(startIndex, endIndex).toString() === "echo",
      ),
      Chunk.size,
    ),
    2,
  );
});

