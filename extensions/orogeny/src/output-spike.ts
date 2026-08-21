import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Chunk, Console, Data, Effect, Layer, Option, pipe, Schema } from "effect";
import { Jupyter } from "#o/jupyter";
import { CellOutput } from "#o/output";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const root = mkdtempSync(join(tmpdir(), "orogeny-output-spike-"));
const directory = join(root, "cell");
const decodeBundle = Schema.decodeUnknownSync(Jupyter.MimeBundle);

class AssertionFailed extends Data.TaggedError("OutputSpikeAssertionFailed")<{
  readonly message: string;
}> {}

const assert = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new AssertionFailed({ message }));

const display = (data: Readonly<Record<string, Schema.Json>>) =>
  Jupyter.Output.display({
    kind: "display_data",
    data: decodeBundle(data),
    metadata: {},
    transient: Option.none(),
    executionCount: Option.none(),
  });

const drain = Effect.fnUntraced(function* (
  handle: CellOutput.Handle,
  cursor = CellOutput.Cursor.start(),
  pages: Chunk.Chunk<CellOutput.ReadResult> = Chunk.empty(),
): Effect.fn.Return<
  Chunk.Chunk<CellOutput.ReadResult>,
  CellOutput.OperationFailed | AssertionFailed
> {
  const page = yield* handle.read(
    new CellOutput.ReadInput({
      cursor,
      sealed: true,
      maxBytes: 256,
      maxLines: 3,
    }),
  );
  const next = Chunk.append(pages, page);
  if (!page.hasMore) return next;
  yield* assert(
    page.cursor.toString() !== cursor.toString(),
    `Pagination did not advance from ${cursor}`,
  );
  return yield* drain(handle, page.cursor, next);
});

const program = Effect.gen(function* () {
  const outputs = yield* CellOutput.Service;
  const handle = yield* outputs.open(directory);

  yield* handle.append(Jupyter.Output.stream({ name: "stdout", text: "loading..." }));
  yield* handle.append(
    display({
      "application/json": { answer: 42 },
      "text/plain": "answer: 42",
    }),
  );
  yield* handle.append(Jupyter.Output.stream({ name: "stdout", text: "done\n" }));
  yield* handle.append(
    display({
      "application/vnd.plotly.v1+json": {
        data: [{ x: [1, 2], y: [3, 4] }],
      },
    }),
  );
  yield* handle.append(display({ "image/png": TINY_PNG, "text/plain": "one pixel" }));
  yield* handle.append(
    Jupyter.Output.error({
      name: "Error",
      value: "expected failure",
      traceback: Chunk.make("spike frame"),
    }),
  );
  yield* handle.append(Jupyter.Output.clear({ wait: false }));
  yield* handle.append(display({ "text/plain": "one\ntwo\nthree\nfour\n" }));

  const outputLog = readFileSync(join(directory, "outputs.jsonl"), "utf8");
  const outputLines = outputLog.slice(0, -1).split("\n");
  yield* assert(outputLog.endsWith("\n"), "Output log was not LF-terminated");
  yield* assert(
    outputLines.length === 8,
    `Expected 8 output records, received ${outputLines.length}`,
  );
  yield* Effect.forEach(
    outputLines,
    (line) =>
      Effect.try({
        try: () => JSON.parse(line),
        catch: () => new AssertionFailed({ message: "Output log was not strict JSONL" }),
      }),
    { discard: true },
  );

  const artifacts = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("artifact_"),
  );
  yield* assert(
    artifacts.length === 2,
    `Expected 2 artifact bundles, received ${artifacts.length}`,
  );

  const stream = readFileSync(join(directory, "streams.log"), "utf8").replace(
    /\[[^\]]+ stdout\] /g,
    "[stdout] ",
  );
  yield* assert(
    stream === "[stdout] loading...done\n",
    `Unexpected stream normalization: ${JSON.stringify(stream)}`,
  );

  const pages = yield* drain(handle);
  const content = pipe(
    pages,
    Chunk.flatMap((page) => page.content),
  );
  const renderedText = pipe(
    content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((value) => value.text),
    Chunk.join(""),
  );
  const images = pipe(content, Chunk.filter(CellOutput.Content.$is("image")));
  const boundaries = pipe(
    pages,
    Chunk.map((page) => page.boundary),
  );

  let previous = -1;
  for (const expected of [
    "loading...",
    '{"answer":42}',
    "done\n",
    "application/vnd.plotly.v1+json",
    "[Image]",
    "spike frame\nError: expected failure\n",
    "[clear_output wait=false]",
    "one\ntwo\nthree\nfour\n",
  ]) {
    const index = renderedText.indexOf(expected);
    yield* assert(index > previous, `Expected ${JSON.stringify(expected)} after byte ${previous}`);
    previous = index;
  }

  yield* assert(Chunk.size(images) === 1, "Expected exactly one delivered image");
  yield* assert(
    Chunk.some(boundaries, (boundary) => boundary === "limit"),
    "Delivery limits did not create a page",
  );
  yield* assert(
    Chunk.some(boundaries, (boundary) => boundary === "image"),
    "Image delivery did not end a page",
  );
  yield* assert(
    Chunk.lastUnsafe(pages).cursor.toString() === "oc1:o8:l0",
    "Final cursor did not reach the output-log end",
  );

  const examples = yield* outputs.open(join(root, "read-examples"));
  yield* examples.append(Jupyter.Output.stream({ name: "stdout", text: "loading..." }));

  const partial = yield* examples.read(
    new CellOutput.ReadInput({
      cursor: CellOutput.Cursor.start(),
      sealed: false,
      maxBytes: 1_024,
      maxLines: 100,
    }),
  );
  const partialText = pipe(
    partial.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((value) => value.text),
    Chunk.join(""),
  );
  yield* assert(partialText.endsWith("loading..."), "Partial stream text was not delivered");
  yield* assert(
    partial.cursor.position.byte !== undefined,
    "Partial stream did not produce a byte cursor",
  );

  yield* examples.append(Jupyter.Output.stream({ name: "stdout", text: "done\n" }));
  yield* examples.append(display({ "text/plain": "text before image\n" }));
  yield* examples.append(display({ "image/png": TINY_PNG, "text/plain": "one pixel" }));
  yield* examples.append(display({ "text/plain": "abcdefghij\n" }));

  const joined = yield* examples.read(
    new CellOutput.ReadInput({
      cursor: partial.cursor,
      sealed: true,
      maxBytes: 1_024,
      maxLines: 100,
    }),
  );
  const joinedContent = pipe(
    joined.content,
    Chunk.map((value) =>
      CellOutput.Content.$is("text")(value)
        ? { type: "text", value: value.text }
        : { type: "image", mimeType: value.mimeType },
    ),
    Chunk.toReadonlyArray,
  );
  yield* assert(
    joined.boundary === "image",
    "Joined text and image did not end at the image boundary",
  );
  yield* assert(
    Chunk.some(
      joined.content,
      (value) => CellOutput.Content.$is("text")(value) && value.text === "done\n",
    ),
    "Stream continuation was not delivered",
  );
  yield* assert(
    Chunk.some(
      joined.content,
      (value) => CellOutput.Content.$is("text")(value) && value.text === "text before image\n",
    ),
    "Text was not joined with the image page",
  );
  yield* assert(
    Chunk.some(
      joined.content,
      (value) => CellOutput.Content.$is("image")(value) && value.mimeType === "image/png",
    ),
    "Image was not joined with the text page",
  );

  const long = yield* examples.read(
    new CellOutput.ReadInput({
      cursor: joined.cursor,
      sealed: true,
      maxBytes: 4,
      maxLines: 100,
    }),
  );
  const longText = pipe(
    long.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((value) => value.text),
    Chunk.join(""),
  );
  yield* assert(longText === "abcd", "Long line was not split at the byte limit");
  yield* assert(
    long.cursor.toString() === "oc1:o3:l0:b4",
    "Long line did not produce the expected byte cursor",
  );

  const resumed = yield* examples.read(
    new CellOutput.ReadInput({
      cursor: long.cursor,
      sealed: true,
      maxBytes: 1_024,
      maxLines: 100,
    }),
  );
  const resumedText = pipe(
    resumed.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((value) => value.text),
    Chunk.join(""),
  );
  yield* assert(resumedText === "efghij\n", "Long line did not resume from its byte cursor");

  yield* Console.log("cell output spike: normalized writes and strict storage passed");
  yield* Console.log("cell output spike: bounded reads, references, images, and cursors passed");
  yield* Console.log(
    "cell output spike: byte cursor and joined-image examples",
    JSON.stringify(
      {
        openPartialStream: {
          text: partialText,
          cursor: partial.cursor.toString(),
          boundary: partial.boundary,
        },
        textJoinedWithImage: {
          content: joinedContent,
          cursor: joined.cursor.toString(),
          boundary: joined.boundary,
        },
        longLineAtFourBytes: {
          text: longText,
          cursor: long.cursor.toString(),
          boundary: long.boundary,
        },
        resumedLongLine: {
          text: resumedText,
          cursor: resumed.cursor.toString(),
          boundary: resumed.boundary,
        },
      },
      null,
      2,
    ),
  );
});

const mainLayer = pipe(CellOutput.layer, Layer.provide(NodeServices.layer));

pipe(
  program,
  Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
  Effect.provide(mainLayer),
  NodeRuntime.runMain,
);
