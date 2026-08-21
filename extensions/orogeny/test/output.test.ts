import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import * as Pi from "@earendil-works/pi-coding-agent";
import { Chunk, Effect, Layer, Option, pipe, Schema } from "effect";
import { Jupyter } from "#o/jupyter";
import { CellOutput } from "#o/output";
import * as Mime from "../src/output/mime.ts";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const outputLayer = pipe(CellOutput.layer, Layer.provide(NodeServices.layer));
const decodeBundle = Schema.decodeUnknownSync(Jupyter.MimeBundle);
const decodeOutputLine = Schema.decodeUnknownSync(CellOutput.OutputLine);

const run = <A, E>(effect: Effect.Effect<A, E, CellOutput.Service>) =>
  pipe(effect, Effect.provide(outputLayer), Effect.runPromise);

const fixture = async <A, E>(body: (outputs: CellOutput.Interface, root: string) => Effect.Effect<A, E>) => {
  const root = mkdtempSync(join(tmpdir(), "orogeny-output-test-"));
  try {
    return await run(
      Effect.gen(function* () {
        return yield* body(yield* CellOutput.Service, root);
      }),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

const display = (
  data: Readonly<Record<string, Schema.Json>>,
  options: {
    readonly kind?: "execute_result" | "display_data" | "update_display_data";
    readonly count?: Option.Option<number>;
    readonly metadata?: Schema.Json;
    readonly transient?: Option.Option<Schema.Json>;
  } = {},
) =>
  Jupyter.Output.display({
    kind: options.kind ?? "display_data",
    data: decodeBundle(data),
    metadata: options.metadata ?? {},
    transient: options.transient ?? Option.none(),
    executionCount: options.count ?? Option.none(),
  });

const plain = (text: string) => display({ "text/plain": text });

const read = (
  handle: CellOutput.Handle,
  options: {
    readonly cursor?: CellOutput.Cursor;
    readonly sealed?: boolean;
    readonly maxBytes?: number;
    readonly maxLines?: number;
  } = {},
) =>
  handle.read(
    new CellOutput.ReadInput({
      cursor: options.cursor ?? CellOutput.Cursor.start(),
      sealed: options.sealed ?? true,
      maxBytes: options.maxBytes ?? Pi.DEFAULT_MAX_BYTES,
      maxLines: options.maxLines ?? Pi.DEFAULT_MAX_LINES,
    }),
  );

const textBlocks = (result: CellOutput.ReadResult) =>
  pipe(
    result.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((content) => content.text),
    Chunk.toReadonlyArray,
  );

const imageBlocks = (result: CellOutput.ReadResult) =>
  pipe(result.content, Chunk.filter(CellOutput.Content.$is("image")), Chunk.toReadonlyArray);

const text = (result: CellOutput.ReadResult) => textBlocks(result).join("");

const records = (directory: string) => {
  const value = readFileSync(join(directory, "outputs.jsonl"), "utf8");
  if (value.length === 0) return [];
  assert.equal(value.endsWith("\n"), true);
  return value
    .slice(0, -1)
    .split("\n")
    .map((line) => decodeOutputLine(line));
};

const artifactDirectories = (directory: string) =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("artifact_"))
    .map((entry) => entry.name);

const normalizedStream = (directory: string) =>
  readFileSync(join(directory, "streams.log"), "utf8").replace(/\[[^\]]+ (stdout|stderr)\] /g, "[$1] ");

test("stored MIME schema requires exactly one storage representation", () => {
  const base = {
    type: "display_data",
    timestamp: "2026-03-01T00:00:00.000Z",
    metadata: {},
  } as const;
  const accepts = (value: Schema.Json) => Option.isSome(Schema.decodeUnknownOption(CellOutput.OutputRecord)(value));

  assert.equal(accepts({ ...base, value: { "text/plain": "ok" } }), true);
  assert.equal(accepts({ ...base, artifact_id: "artifact_123" }), true);
  assert.equal(accepts(base), false);
  assert.equal(
    accepts({
      ...base,
      value: { "text/plain": "ok" },
      artifact_id: "artifact_123",
    }),
    false,
  );

  for (const cursor of ["", "oc2:o0:l0", "oc1:o-1:l0", "oc1:o0:l-1", "oc1:o0:l0:b0"])
    assert.equal(Option.isNone(Schema.decodeUnknownOption(CellOutput.Cursor.FromString)(cursor)), true);
});

test("MIME policy covers every handling, encoding, priority, and inline guard", async () => {
  assert.deepEqual(Mime.ruleFor("text/plain"), ["concatenate", "utf8"]);
  assert.deepEqual(Mime.ruleFor("application/json"), ["concatenate", "json"]);
  assert.deepEqual(Mime.ruleFor("image/svg+xml"), ["indivisible", "utf8"]);
  assert.deepEqual(Mime.ruleFor("image/png"), ["indivisible", "base64"]);
  assert.deepEqual(Mime.ruleFor("application/javascript"), ["reference", "utf8"]);
  assert.deepEqual(Mime.ruleFor("audio/wav"), ["reference", "base64"]);
  assert.deepEqual(Mime.ruleFor("video/mp4"), ["reference", "base64"]);
  assert.deepEqual(Mime.ruleFor("application/pdf"), ["reference", "base64"]);
  assert.deepEqual(Mime.ruleFor("application/vnd.plotly.v1+json"), ["reference", "json"]);
  assert.deepEqual(Mime.ruleFor("application/x-custom"), ["reference", "json"]);

  const priority = [
    "image/png",
    "image/svg+xml",
    "application/json",
    "text/html",
    "text/markdown",
    "text/latex",
    "text/plain",
    "text/csv",
    "application/pdf",
    "application/vnd.plotly.v1+json",
  ];
  for (const index of priority.keys()) {
    const entries = priority.slice(index).map((mime) => [mime, mime] as const);
    assert.equal(Mime.preferred(entries)?.[0], priority[index]);
  }

  for (const mime of ["text/plain", "image/svg+xml", "application/vnd.plotly.v1+json", "application/x.custom+json"])
    assert.equal(Mime.mimeFromFilename(Mime.filename(mime)), mime);

  const small = await Effect.runPromise(Mime.normalize(decodeBundle({ "text/plain": "small" })));
  const tooManyLines = await Effect.runPromise(
    Mime.normalize(
      decodeBundle({
        "text/plain": Array.from({ length: Pi.DEFAULT_MAX_LINES + 1 }, () => "line").join("\n"),
      }),
    ),
  );
  const mixed = await Effect.runPromise(
    Mime.normalize(
      decodeBundle({
        "text/plain": "fallback",
        "application/vnd.plotly.v1+json": { data: [] },
      }),
    ),
  );

  assert.equal(Mime.fitsInline(small), true);
  assert.equal(Mime.fitsInline(tooManyLines), false);
  assert.equal(Mime.fitsInline(mixed), false);
});

test("open creates empty private logs and rejects an existing cell", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const directory = join(root, "cell");
      const handle = yield* outputs.open(directory);

      assert.equal(readFileSync(join(directory, "outputs.jsonl"), "utf8"), "");
      assert.equal(readFileSync(join(directory, "streams.log"), "utf8"), "");
      assert.equal(statSync(join(directory, "outputs.jsonl")).mode & 0o777, 0o600);

      const empty = yield* read(handle);
      assert.equal(Chunk.isEmpty(empty.content), true);
      assert.equal(empty.cursor.toString(), "oc1:o0:l0");
      assert.equal(empty.boundary, "exhausted");
      assert.equal(empty.hasMore, false);

      const failure = yield* Effect.flip(outputs.open(directory));
      assert.equal(failure.operation, "create cell output");
    }),
  ));

test("stream chunks, channel switches, and rich-output ranges preserve order", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const chunksDirectory = join(root, "chunks");
      const chunks = yield* outputs.open(chunksDirectory);
      yield* chunks.append(Jupyter.Output.stream({ name: "stdout", text: "hel" }));
      yield* chunks.append(Jupyter.Output.stream({ name: "stdout", text: "lo\nnext" }));
      yield* chunks.append(Jupyter.Output.stream({ name: "stderr", text: "err\n" }));
      yield* chunks.append(Jupyter.Output.stream({ name: "stdout", text: "" }));

      assert.equal(normalizedStream(chunksDirectory), "[stdout] hello\n[stdout] next\n[stderr] err\n");
      assert.deepEqual(
        records(chunksDirectory).map((record) => record.type),
        ["stream"],
      );

      const endingsDirectory = join(root, "line-endings");
      const endings = yield* outputs.open(endingsDirectory);
      yield* endings.append(Jupyter.Output.stream({ name: "stdout", text: "\r\n\nbare\r" }));
      assert.equal(normalizedStream(endingsDirectory), "[stdout] \r\n[stdout] \n[stdout] bare\r");

      const rangesDirectory = join(root, "ranges");
      const ranges = yield* outputs.open(rangesDirectory);
      yield* ranges.append(Jupyter.Output.stream({ name: "stdout", text: "loading..." }));
      yield* ranges.append(plain("middle\n"));
      const offset = Buffer.byteLength(readFileSync(join(rangesDirectory, "streams.log"), "utf8"));
      yield* ranges.append(Jupyter.Output.stream({ name: "stdout", text: "done\n" }));

      const stored = records(rangesDirectory);
      assert.deepEqual(
        stored.map((record) => record.type),
        ["stream", "display_data", "stream"],
      );
      assert.equal(stored[0]?.type === "stream" && stored[0].offset, 0);
      assert.equal(stored[2]?.type === "stream" && stored[2].offset, offset);
      assert.equal(normalizedStream(rangesDirectory), "[stdout] loading...done\n");

      const projected = yield* read(ranges);
      const blocks = textBlocks(projected);
      assert.match(blocks[0] ?? "", /loading\.\.\.$/);
      assert.equal(blocks[1], "middle\n");
      assert.equal(blocks[2], "done\n");
      assert.equal(projected.cursor.toString(), "oc1:o3:l0");
    }),
  ));

test("error, clear, display update, and execute result round-trip", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const directory = join(root, "structured");
      const handle = yield* outputs.open(directory);
      yield* handle.append(
        Jupyter.Output.error({
          name: "TypeError",
          value: "boom",
          traceback: Chunk.make("frame one", "frame two"),
        }),
      );
      yield* handle.append(Jupyter.Output.clear({ wait: true }));
      yield* handle.append(
        display(
          { "text/plain": "updated\n" },
          {
            kind: "update_display_data",
            metadata: { source: "test" },
            transient: Option.some({ display_id: "display-1" }),
          },
        ),
      );
      yield* handle.append(display({ "text/plain": "42\n" }, { kind: "execute_result", count: Option.some(7) }));

      assert.deepEqual(textBlocks(yield* read(handle)), [
        "frame one\nframe two\nTypeError: boom\n",
        "[clear_output wait=true]\n",
        "updated\n",
        "42\n",
      ]);

      const stored = records(directory);
      assert.deepEqual(
        stored.map((record) => record.type),
        ["error", "clear_output", "update_display_data", "execute_result"],
      );
      const update = stored[2];
      const result = stored[3];
      assert.deepEqual(update?.type === "update_display_data" ? update.transient : undefined, {
        display_id: "display-1",
      });
      assert.equal(result?.type === "execute_result" && result.execution_count, 7);

      const invalidDirectory = join(root, "invalid-execute-result");
      const invalid = yield* outputs.open(invalidDirectory);
      const failure = yield* Effect.flip(
        invalid.append(display({ "text/plain": "missing" }, { kind: "execute_result" })),
      );
      assert.equal(failure.operation, "store execute result");
      assert.equal(readFileSync(join(invalidDirectory, "outputs.jsonl"), "utf8"), "");
    }),
  ));

test("inline and external MIME bundles retain every representation", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const inlineDirectory = join(root, "inline");
      const inline = yield* outputs.open(inlineDirectory);
      yield* inline.append(
        display({
          "text/plain": "plain",
          "application/json": { answer: 42 },
        }),
      );

      const inlineRecord = records(inlineDirectory)[0];
      assert.equal(inlineRecord?.type === "display_data" && inlineRecord.artifact_id, undefined);
      assert.deepEqual(inlineRecord?.type === "display_data" && inlineRecord.value, {
        "text/plain": "plain",
        "application/json": { answer: 42 },
      });
      assert.deepEqual(artifactDirectories(inlineDirectory), []);
      assert.equal(text(yield* read(inline)), '{"answer":42}');

      const externalDirectory = join(root, "external");
      const external = yield* outputs.open(externalDirectory);
      const large = "é".repeat(Pi.DEFAULT_MAX_BYTES);
      yield* external.append(display({ "text/plain": large }));

      const externalRecord = records(externalDirectory)[0];
      assert.equal(externalRecord?.type === "display_data" && externalRecord.value, undefined);
      assert.equal(externalRecord?.type === "display_data", true);
      if (externalRecord?.type !== "display_data" || externalRecord.artifact_id === undefined)
        return yield* Effect.die("Expected external MIME record");

      const artifact = join(externalDirectory, externalRecord.artifact_id);
      assert.deepEqual(readdirSync(artifact), [Mime.filename("text/plain")]);
      assert.equal(readFileSync(join(artifact, Mime.filename("text/plain")), "utf8"), large);

      const first = yield* read(external, { maxBytes: 1_024, maxLines: 10 });
      assert.equal(Buffer.byteLength(text(first)), 1_024);
      assert.equal(first.cursor.toString(), "oc1:o0:l0:b1024");
      assert.equal(first.hasMore, true);
    }),
  ));

test("reference MIME encodings are lossless and project as artifact links", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const directory = join(root, "references");
      const handle = yield* outputs.open(directory);
      const binary = Buffer.from("binary payload");
      const cases = [
        ["application/javascript", "console.log('ok')", Buffer.from("console.log('ok')")],
        ["application/pdf", binary.toString("base64"), binary],
        ["audio/wav", binary.toString("base64"), binary],
        ["video/mp4", binary.toString("base64"), binary],
        ["application/vnd.plotly.v1+json", { data: [1, 2, 3] }, Buffer.from('{"data":[1,2,3]}')],
        ["application/x-custom", { nested: true }, Buffer.from('{"nested":true}')],
      ] as const;

      yield* Effect.forEach(cases, ([mime, value]) => handle.append(display({ [mime]: value })), {
        discard: true,
      });

      const stored = records(directory);
      assert.equal(stored.length, cases.length);
      for (const [index, [mime, , expected]] of cases.entries()) {
        const record = stored[index];
        if (record?.type !== "display_data" || record.artifact_id === undefined)
          return yield* Effect.die(`Expected artifact for ${mime}`);
        const representation = readFileSync(join(directory, record.artifact_id, Mime.filename(mime)));
        assert.deepEqual(representation, expected);
      }

      const projected = yield* read(handle);
      assert.equal(imageBlocks(projected).length, 0);
      assert.equal(textBlocks(projected).length, cases.length);
      for (const [index, [mime]] of cases.entries()) {
        assert.match(textBlocks(projected)[index] ?? "", /^\[artifact_[\w-]+\]\(<.*artifact_[\w-]+>\)/);
        assert.match(textBlocks(projected)[index] ?? "", new RegExp(`\\{${mime.replaceAll("+", "\\+")}\\}`));
      }
    }),
  ));

test("images are normalized, page-bounded, and invalid images fall back to references", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const directory = join(root, "images");
      const handle = yield* outputs.open(directory);
      const image = display({ "image/png": TINY_PNG, "text/plain": "image" });
      yield* handle.append(image);
      yield* handle.append(image);

      const first = yield* read(handle);
      assert.equal(first.boundary, "image");
      assert.equal(first.cursor.toString(), "oc1:o1:l0");
      assert.equal(first.hasMore, true);
      assert.equal(textBlocks(first).length, 1);
      assert.match(textBlocks(first)[0] ?? "", /^\[Image\]\(<.*artifact_/);
      assert.match(textBlocks(first)[0] ?? "", /image\/png/);
      assert.match(textBlocks(first)[0] ?? "", /text\/plain/);
      assert.equal(imageBlocks(first).length, 1);
      assert.equal(imageBlocks(first)[0]?.mimeType, "image/png");

      const annotation = textBlocks(first)[0] ?? "";
      const beforeImage = yield* read(handle, {
        maxBytes: Buffer.byteLength(annotation),
        maxLines: 100,
      });
      assert.equal(beforeImage.boundary, "limit");
      assert.equal(imageBlocks(beforeImage).length, 0);
      assert.equal(beforeImage.cursor.toString(), "oc1:o0:l1");
      assert.equal(beforeImage.hasMore, true);

      const splitAnnotation = yield* read(handle, { maxBytes: 10, maxLines: 100 });
      assert.equal(Buffer.byteLength(text(splitAnnotation)), 10);
      assert.equal(splitAnnotation.cursor.toString(), "oc1:o0:l0:b10");
      assert.equal(imageBlocks(splitAnnotation).length, 0);
      const afterSplit = yield* read(handle, { cursor: splitAnnotation.cursor });
      assert.equal(afterSplit.boundary, "image");
      assert.equal(imageBlocks(afterSplit).length, 1);

      const onlyImage = yield* read(handle, { cursor: beforeImage.cursor });
      assert.equal(text(onlyImage), "");
      assert.equal(imageBlocks(onlyImage).length, 1);
      assert.equal(onlyImage.boundary, "image");
      assert.equal(onlyImage.cursor.toString(), "oc1:o1:l0");

      const second = yield* read(handle, { cursor: first.cursor });
      assert.equal(second.boundary, "image");
      assert.equal(second.cursor.toString(), "oc1:o2:l0");
      assert.equal(second.hasMore, false);

      const invalidDirectory = join(root, "invalid-image");
      const invalid = yield* outputs.open(invalidDirectory);
      yield* invalid.append(display({ "image/png": Buffer.from("not an image").toString("base64") }));
      const fallback = yield* read(invalid);
      assert.equal(imageBlocks(fallback).length, 0);
      assert.match(text(fallback), /^\[artifact_[\w-]+\]\(/);
      assert.equal(fallback.boundary, "exhausted");
    }),
  ));

test("line and byte guards preserve complete lines and canonical cursors", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const lines = yield* outputs.open(join(root, "lines"));
      yield* lines.append(plain("a\nb\nc\n"));
      const first = yield* read(lines, { maxBytes: 100, maxLines: 2 });
      assert.equal(text(first), "a\nb\n");
      assert.equal(first.cursor.toString(), "oc1:o0:l2");
      assert.equal(first.boundary, "limit");
      assert.equal(first.hasMore, true);
      const second = yield* read(lines, { cursor: first.cursor, maxBytes: 100, maxLines: 2 });
      assert.equal(text(second), "c\n");
      assert.equal(second.cursor.toString(), "oc1:o1:l0");
      assert.equal(second.hasMore, false);

      const complete = yield* outputs.open(join(root, "complete"));
      yield* complete.append(plain("aa\n"));
      yield* complete.append(plain("bbbb\n"));
      const completeFirst = yield* read(complete, { maxBytes: 5, maxLines: 10 });
      assert.equal(text(completeFirst), "aa\n");
      assert.equal(completeFirst.cursor.toString(), "oc1:o1:l0");
      const completeSecond = yield* read(complete, {
        cursor: completeFirst.cursor,
        maxBytes: 5,
        maxLines: 10,
      });
      assert.equal(text(completeSecond), "bbbb\n");
      assert.equal(completeSecond.cursor.toString(), "oc1:o2:l0");
      assert.equal(completeSecond.boundary, "limit");
      assert.equal(completeSecond.hasMore, false);

      const crlf = yield* outputs.open(join(root, "crlf"));
      yield* crlf.append(plain("one\r\ntwo\r\n"));
      const crlfFirst = yield* read(crlf, { maxBytes: 100, maxLines: 1 });
      assert.equal(text(crlfFirst), "one\r\n");

      const noBudget = yield* read(lines, { maxBytes: 0, maxLines: 0 });
      assert.equal(Chunk.isEmpty(noBudget.content), true);
      assert.equal(noBudget.cursor.toString(), "oc1:o0:l0");
      assert.equal(noBudget.boundary, "limit");
      assert.equal(noBudget.hasMore, true);

      const emptyText = yield* outputs.open(join(root, "empty-text"));
      yield* emptyText.append(plain(""));
      const emptyTextPage = yield* read(emptyText);
      assert.equal(Chunk.isEmpty(emptyTextPage.content), true);
      assert.equal(emptyTextPage.cursor.toString(), "oc1:o1:l0");
      assert.equal(emptyTextPage.hasMore, false);
    }),
  ));

test("oversized UTF-8 lines resume exactly and invalid content cursors fail", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const handle = yield* outputs.open(join(root, "utf8"));
      yield* handle.append(plain("ééé"));

      const first = yield* read(handle, { maxBytes: 5, maxLines: 10 });
      assert.equal(text(first), "éé");
      assert.equal(first.cursor.toString(), "oc1:o0:l0:b4");
      const second = yield* read(handle, { cursor: first.cursor, maxBytes: 5, maxLines: 10 });
      assert.equal(text(second), "é");
      assert.equal(second.cursor.toString(), "oc1:o1:l0");

      const invalid = [
        new CellOutput.Position({ output: 2, line: 0, byte: undefined }),
        new CellOutput.Position({ output: 1, line: 1, byte: undefined }),
        new CellOutput.Position({ output: 0, line: 2, byte: undefined }),
        new CellOutput.Position({ output: 0, line: 0, byte: 1 }),
        new CellOutput.Position({ output: 0, line: 0, byte: 99 }),
      ];
      for (const position of invalid) {
        const failure = yield* Effect.flip(read(handle, { cursor: CellOutput.Cursor.from(position) }));
        assert.equal(failure.operation, "read cell output");
      }
    }),
  ));

test("live stream cursors deliver only new bytes and seal without phantom lines", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const live = yield* outputs.open(join(root, "live"));
      yield* live.append(Jupyter.Output.stream({ name: "stdout", text: "loading..." }));

      const first = yield* read(live, { sealed: false });
      assert.match(text(first), /loading\.\.\.$/);
      assert.match(first.cursor.toString(), /^oc1:o0:l0:b\d+$/);
      assert.equal(first.hasMore, false);

      yield* live.append(Jupyter.Output.stream({ name: "stdout", text: "done\n" }));
      const second = yield* read(live, { cursor: first.cursor, sealed: false });
      assert.equal(text(second), "done\n");
      assert.equal(second.cursor.toString(), "oc1:o0:l1");
      assert.equal(second.hasMore, false);

      const sealed = yield* read(live, { cursor: second.cursor, sealed: true });
      assert.equal(text(sealed), "");
      assert.equal(sealed.lines, 0);
      assert.equal(sealed.cursor.toString(), "oc1:o1:l0");

      const partial = yield* outputs.open(join(root, "partial"));
      yield* partial.append(Jupyter.Output.stream({ name: "stdout", text: "partial" }));
      const partialFirst = yield* read(partial, { sealed: false });
      const partialSealed = yield* read(partial, { cursor: partialFirst.cursor, sealed: true });
      assert.equal(text(partialSealed), "");
      assert.equal(partialSealed.lines, 0);
      assert.equal(partialSealed.cursor.toString(), "oc1:o1:l0");

      const range = yield* outputs.open(join(root, "sealed-range"));
      yield* range.append(Jupyter.Output.stream({ name: "stdout", text: "loading" }));
      yield* range.append(plain("after"));
      const streamBytes = readFileSync(join(root, "sealed-range", "streams.log")).length;
      const rangePage = yield* read(range, { sealed: false, maxBytes: streamBytes, maxLines: 100 });
      assert.match(text(rangePage), /loading$/);
      assert.equal(rangePage.cursor.toString(), "oc1:o1:l0");
    }),
  ));

test("reader ignores uncommitted JSONL, rejects committed corruption, and writer serializes concurrency", () =>
  fixture((outputs, root) =>
    Effect.gen(function* () {
      const trailingDirectory = join(root, "trailing");
      const trailing = yield* outputs.open(trailingDirectory);
      yield* trailing.append(plain("committed\n"));
      appendFileSync(join(trailingDirectory, "outputs.jsonl"), "{uncommitted");
      assert.equal(text(yield* read(trailing)), "committed\n");

      appendFileSync(join(trailingDirectory, "outputs.jsonl"), "}\n");
      const corrupt = yield* Effect.flip(read(trailing));
      assert.equal(corrupt.operation, "read cell output");

      const concurrentDirectory = join(root, "concurrent");
      const concurrent = yield* outputs.open(concurrentDirectory);
      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, index) => index),
        (index) => concurrent.append(plain(`${index}\n`)),
        { concurrency: "unbounded", discard: true },
      );
      const concurrentRecords = records(concurrentDirectory);
      assert.equal(concurrentRecords.length, 100);
      const projected = yield* read(concurrent, { maxBytes: 10_000, maxLines: 200 });
      assert.equal(textBlocks(projected).length, 100);

      const failedDirectory = join(root, "failed-write");
      const failed = yield* outputs.open(failedDirectory);
      rmSync(failedDirectory, { force: true, recursive: true });
      const writeFailure = yield* Effect.flip(failed.append(plain("cannot write")));
      assert.equal(writeFailure.operation, "append cell output record");
      assert.equal(existsSync(failedDirectory), false);
    }),
  ));
