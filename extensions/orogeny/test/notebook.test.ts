import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import * as Pi from "@earendil-works/pi-coding-agent";
import { Chunk, Clock, Deferred, Effect, Fiber, Layer, Option, pipe, Stream, String as Str } from "effect";
import { Jupyter } from "#o/jupyter";
import { Notebook } from "#o/notebook";
import { CellOutput } from "#o/output";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const fixture = async <A, E>(body: (notebooks: Notebook.Interface) => Effect.Effect<A, E>) => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "orogeny-notebook-test-"));
  const layer = pipe(
    Notebook.layer(
      new Notebook.Config({
        artifactRoot,
        maxLiveNotebooks: 1,
        maxWaitMillis: 5 * 60 * 1_000,
        interruptGraceMillis: 5_000,
      }),
    ),
    Layer.provide(Jupyter.layer),
    Layer.provide(CellOutput.layer),
    Layer.provide(NodeServices.layer),
  );

  try {
    return await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          return yield* body(yield* Notebook.Service);
        }),
        Effect.provide(layer),
      ),
    );
  } finally {
    rmSync(artifactRoot, { force: true, recursive: true });
  }
};

const collectWait = (
  notebooks: Notebook.Interface,
  cellId: Notebook.CellId,
  cursor: Option.Option<CellOutput.Cursor>,
  timeoutMillis: number,
) =>
  pipe(
    notebooks.wait(new Notebook.WaitInput({ cellId, cursor, timeoutMillis })),
    Stream.runCollect,
    Effect.map(Chunk.fromIterable),
  );

const completion = (events: Chunk.Chunk<Notebook.WaitEvent>) => {
  const completions = pipe(events, Chunk.filter(Notebook.WaitEvent.$is("complete")));
  assert.equal(Chunk.size(completions), 1);
  assert.equal(Notebook.WaitEvent.$is("complete")(Chunk.lastUnsafe(events)), true);
  return Chunk.headUnsafe(completions);
};

const content = (events: Chunk.Chunk<Notebook.WaitEvent>) =>
  pipe(
    events,
    Chunk.filter(Notebook.WaitEvent.$is("content")),
    Chunk.map((event) => event.value),
  );

const text = (events: Chunk.Chunk<Notebook.WaitEvent>) =>
  pipe(
    content(events),
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((value) => value.text),
    Chunk.join(""),
  );

const awaitTerminal = Effect.fnUntraced(function* (
  notebooks: Notebook.Interface,
  cellId: Notebook.CellId,
  cursor: Option.Option<CellOutput.Cursor> = Option.none(),
): Effect.fn.Return<void, Notebook.OperationFailed> {
  const result = completion(yield* collectWait(notebooks, cellId, cursor, 5_000));
  if (result.status !== "running") return;
  return yield* awaitTerminal(notebooks, cellId, Option.some(result.nextCursor));
});

test("wait returns immediately when captured output exactly fills the delivery page", { timeout: 20_000 }, () =>
  fixture((notebooks) =>
    Effect.gen(function* () {
      assert.equal(Pi.DEFAULT_MAX_LINES, 2_000);

      const notebook = yield* notebooks.create();
      const cell = yield* notebooks.start(
        new Notebook.StartInput({
          notebookId: Option.some(notebook.id),
          code: `
const lines = Array.from({ length: 2000 }, () => "x").join("\\n");
await Deno.jupyter.display({ "text/plain": lines }, { raw: true });
await new Promise((resolve) => setTimeout(resolve, 3000));
`,
        }),
      );

      const observedEvents = yield* collectWait(notebooks, cell, Option.none(), 5_000);
      const observedCompletion = completion(observedEvents);
      assert.equal(observedCompletion.status, "running");
      assert.equal(observedCompletion.hasMore, false);
      assert.equal(text(observedEvents).split("\n").length, 2_000);

      const immediateEvents = yield* pipe(
        collectWait(notebooks, cell, Option.none(), 5_000),
        Effect.timeout("1 second"),
      );
      const immediateCompletion = completion(immediateEvents);
      assert.equal(immediateCompletion.status, "running");
      assert.equal(immediateCompletion.hasMore, false);
      assert.equal(immediateCompletion.nextCursor.toString(), "oc1:o1:l0");
      assert.equal(text(immediateEvents), text(observedEvents));

      const terminalEvents = yield* collectWait(notebooks, cell, Option.some(immediateCompletion.nextCursor), 5_000);
      const terminalCompletion = completion(terminalEvents);
      assert.equal(terminalCompletion.status, "succeeded");
      assert.equal(terminalCompletion.hasMore, false);
      assert.equal(Chunk.some(terminalEvents, Notebook.WaitEvent.$is("content")), false);
    }),
  ),
);

test("wait paginates logical lines and joins the remaining text with an image", { timeout: 20_000 }, () =>
  fixture((notebooks) =>
    Effect.gen(function* () {
      const notebook = yield* notebooks.create();
      const cell = yield* notebooks.start(
        new Notebook.StartInput({
          notebookId: Option.some(notebook.id),
          code: `
const pagedLines = Array.from({ length: 2001 }, () => "x").join("\\n");
await Deno.jupyter.display({ "text/plain": pagedLines }, { raw: true });
await Deno.jupyter.display({ "image/png": "${TINY_PNG}", "text/plain": "one pixel" }, { raw: true });
`,
        }),
      );
      yield* awaitTerminal(notebooks, cell);

      const linesPage = yield* collectWait(notebooks, cell, Option.none(), 5_000);
      const linesComplete = completion(linesPage);
      assert.equal(linesComplete.status, "succeeded");
      assert.equal(linesComplete.nextCursor.toString(), "oc1:o0:l2000");
      assert.equal(linesComplete.hasMore, true);
      assert.equal(pipe(text(linesPage), Str.linesWithSeparators, Chunk.fromIterable, Chunk.size), 2_000);
      assert.equal(Chunk.some(content(linesPage), CellOutput.Content.$is("image")), false);

      const imagePage = yield* collectWait(notebooks, cell, Option.some(linesComplete.nextCursor), 5_000);
      const imageComplete = completion(imagePage);
      const imageContent = content(imagePage);
      assert.equal(imageComplete.status, "succeeded");
      assert.equal(imageComplete.nextCursor.toString(), "oc1:o2:l0");
      assert.equal(imageComplete.hasMore, false);
      assert.equal(Chunk.size(imageContent), 3);

      const remainingLine = Chunk.getUnsafe(imageContent, 0);
      const annotation = Chunk.getUnsafe(imageContent, 1);
      const image = Chunk.getUnsafe(imageContent, 2);
      assert.ok(CellOutput.Content.$is("text")(remainingLine));
      assert.equal(remainingLine.text, "x");
      assert.ok(CellOutput.Content.$is("text")(annotation));
      assert.match(annotation.text, /^\[Image\]\(<.*artifact_/);
      assert.match(annotation.text, /\{image\/png,text\/plain\}\n$/);
      assert.ok(CellOutput.Content.$is("image")(image));
      assert.equal(image.mimeType, "image/png");
      assert.notEqual(image.data.length, 0);

      const boundaryCell = yield* notebooks.start(
        new Notebook.StartInput({
          notebookId: Option.some(notebook.id),
          code: `
await Deno.jupyter.display({ "image/png": "${TINY_PNG}", "text/plain": "one pixel" }, { raw: true });
await Deno.jupyter.display({ "text/plain": "text after image\\n" }, { raw: true });
`,
        }),
      );
      yield* awaitTerminal(notebooks, boundaryCell);

      const boundaryPage = yield* collectWait(notebooks, boundaryCell, Option.none(), 5_000);
      const boundaryComplete = completion(boundaryPage);
      const boundaryContent = content(boundaryPage);
      assert.equal(boundaryComplete.status, "succeeded");
      assert.equal(boundaryComplete.nextCursor.toString(), "oc1:o1:l0");
      assert.equal(boundaryComplete.hasMore, true);
      assert.equal(Chunk.size(boundaryContent), 2);
      assert.ok(CellOutput.Content.$is("text")(Chunk.getUnsafe(boundaryContent, 0)));
      assert.ok(CellOutput.Content.$is("image")(Chunk.getUnsafe(boundaryContent, 1)));

      const afterImagePage = yield* collectWait(
        notebooks,
        boundaryCell,
        Option.some(boundaryComplete.nextCursor),
        5_000,
      );
      const afterImageComplete = completion(afterImagePage);
      assert.equal(afterImageComplete.status, "succeeded");
      assert.equal(afterImageComplete.nextCursor.toString(), "oc1:o2:l0");
      assert.equal(afterImageComplete.hasMore, false);
      assert.equal(text(afterImagePage), "text after image\n");
    }),
  ),
);

test("wait exposes byte cursors for open and oversized lines", { timeout: 20_000 }, () =>
  fixture((notebooks) =>
    Effect.gen(function* () {
      const notebook = yield* notebooks.create();
      const partialCell = yield* notebooks.start(
        new Notebook.StartInput({
          notebookId: Option.some(notebook.id),
          code: `
const notebookWaitCore = (Deno as any)[(Deno as any).internal].core;
notebookWaitCore.print("partial-loading", false);
await new Promise((resolve) => setTimeout(resolve, 2000));
notebookWaitCore.print("done\\n", false);
`,
        }),
      );

      const partialSeen = yield* Deferred.make<void>();
      const observer = yield* pipe(
        notebooks.wait(
          new Notebook.WaitInput({
            cellId: partialCell,
            cursor: Option.none(),
            timeoutMillis: 5_000,
          }),
        ),
        Stream.tap((event) =>
          Notebook.WaitEvent.$is("content")(event) &&
          CellOutput.Content.$is("text")(event.value) &&
          event.value.text.includes("partial-loading")
            ? pipe(Deferred.succeed(partialSeen, undefined), Effect.asVoid)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* pipe(Deferred.await(partialSeen), Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(observer);

      const partialEvents = yield* collectWait(notebooks, partialCell, Option.none(), 0);
      const partialComplete = completion(partialEvents);
      assert.equal(partialComplete.status, "running");
      assert.equal(partialComplete.hasMore, false);
      assert.match(partialComplete.nextCursor.toString(), /^oc1:o0:l0:b\d+$/);
      assert.notEqual(partialComplete.nextCursor.position.byte, undefined);
      assert.ok(text(partialEvents).endsWith("partial-loading"));

      const continuedEvents = yield* collectWait(
        notebooks,
        partialCell,
        Option.some(partialComplete.nextCursor),
        5_000,
      );
      const continuedComplete = completion(continuedEvents);
      assert.equal(continuedComplete.status, "succeeded");
      assert.equal(continuedComplete.nextCursor.toString(), "oc1:o1:l0");
      assert.equal(continuedComplete.hasMore, false);
      assert.equal(text(continuedEvents), "done\n");

      const oversizedCharacters = Pi.DEFAULT_MAX_BYTES / 2 + 5;
      const oversizedCell = yield* notebooks.start(
        new Notebook.StartInput({
          notebookId: Option.some(notebook.id),
          code: `
const oversizedLine = "é".repeat(${oversizedCharacters});
await Deno.jupyter.display({ "text/plain": oversizedLine }, { raw: true });
`,
        }),
      );
      yield* awaitTerminal(notebooks, oversizedCell);

      const oversizedEvents = yield* collectWait(notebooks, oversizedCell, Option.none(), 5_000);
      const oversizedComplete = completion(oversizedEvents);
      assert.equal(oversizedComplete.status, "succeeded");
      assert.equal(oversizedComplete.nextCursor.toString(), `oc1:o0:l0:b${Pi.DEFAULT_MAX_BYTES}`);
      assert.equal(oversizedComplete.hasMore, true);
      assert.equal(Buffer.byteLength(text(oversizedEvents)), Pi.DEFAULT_MAX_BYTES);

      const oversizedTail = yield* collectWait(
        notebooks,
        oversizedCell,
        Option.some(oversizedComplete.nextCursor),
        5_000,
      );
      const oversizedTailComplete = completion(oversizedTail);
      assert.equal(oversizedTailComplete.status, "succeeded");
      assert.equal(oversizedTailComplete.nextCursor.toString(), "oc1:o1:l0");
      assert.equal(oversizedTailComplete.hasMore, false);
      assert.equal(text(oversizedTail), "é".repeat(5));
    }),
  ),
);

test(
  "wait streams output, waits for status, resumes by cursor, and completes terminal reads",
  { timeout: 30_000 },
  () =>
    fixture((notebooks) =>
      Effect.gen(function* () {
        const notebook = yield* notebooks.create();
        const progressiveCell = yield* notebooks.start(
          new Notebook.StartInput({
            notebookId: Option.some(notebook.id),
            code: `
console.log("progress-before");
await new Promise((resolve) => setTimeout(resolve, 1000));
console.log("progress-after");
`,
          }),
        );

        const firstOutput = yield* Deferred.make<void>();
        const progressiveWait = yield* pipe(
          notebooks.wait(
            new Notebook.WaitInput({
              cellId: progressiveCell,
              cursor: Option.none(),
              timeoutMillis: 5_000,
            }),
          ),
          Stream.tap((event) =>
            Notebook.WaitEvent.$is("content")(event) &&
            CellOutput.Content.$is("text")(event.value) &&
            event.value.text.includes("progress-before")
              ? pipe(Deferred.succeed(firstOutput, undefined), Effect.asVoid)
              : Effect.void,
          ),
          Stream.runCollect,
          Effect.map(Chunk.fromIterable),
          Effect.forkChild,
        );

        yield* pipe(Deferred.await(firstOutput), Effect.timeout("5 seconds"));
        const completedEarly = yield* pipe(Fiber.await(progressiveWait), Effect.timeoutOption("50 millis"));
        assert.equal(Option.isNone(completedEarly), true);

        const progressiveEvents = yield* Fiber.join(progressiveWait);
        const progressiveCompletion = completion(progressiveEvents);
        const progressiveText = text(progressiveEvents);
        assert.equal(progressiveCompletion.status, "succeeded");
        assert.ok(progressiveText.indexOf("progress-before") >= 0);
        assert.ok(progressiveText.indexOf("progress-after") > progressiveText.indexOf("progress-before"));

        const timeoutCell = yield* notebooks.start(
          new Notebook.StartInput({
            notebookId: Option.some(notebook.id),
            code: `
console.log("timeout-before");
await new Promise((resolve) => setTimeout(resolve, 2000));
console.log("timeout-after");
`,
          }),
        );

        const bufferedOutput = yield* Deferred.make<void>();
        const observer = yield* pipe(
          notebooks.wait(
            new Notebook.WaitInput({
              cellId: timeoutCell,
              cursor: Option.none(),
              timeoutMillis: 5_000,
            }),
          ),
          Stream.tap((event) =>
            Notebook.WaitEvent.$is("content")(event) &&
            CellOutput.Content.$is("text")(event.value) &&
            event.value.text.includes("timeout-before")
              ? pipe(Deferred.succeed(bufferedOutput, undefined), Effect.asVoid)
              : Effect.void,
          ),
          Stream.runDrain,
          Effect.forkChild,
        );

        yield* pipe(Deferred.await(bufferedOutput), Effect.timeout("5 seconds"));
        yield* Fiber.interrupt(observer);

        const startedAt = yield* Clock.currentTimeMillis;
        const timedEvents = yield* collectWait(notebooks, timeoutCell, Option.none(), 250);
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        const timedCompletion = completion(timedEvents);
        assert.ok(elapsed >= 180, `Buffered output completed wait after only ${elapsed}ms`);
        assert.equal(timedCompletion.status, "running");
        assert.equal(timedCompletion.hasMore, false);
        assert.match(text(timedEvents), /timeout-before/);

        const resumedEvents = yield* collectWait(
          notebooks,
          timeoutCell,
          Option.some(timedCompletion.nextCursor),
          5_000,
        );
        const resumedCompletion = completion(resumedEvents);
        const resumedText = text(resumedEvents);
        assert.equal(resumedCompletion.status, "succeeded");
        assert.equal(resumedCompletion.hasMore, false);
        assert.doesNotMatch(resumedText, /timeout-before/);
        assert.match(resumedText, /timeout-after/);

        const terminalEvents = yield* pipe(
          collectWait(notebooks, timeoutCell, Option.some(resumedCompletion.nextCursor), 5_000),
          Effect.timeout("1 second"),
        );
        const terminalCompletion = completion(terminalEvents);
        assert.equal(terminalCompletion.status, "succeeded");
        assert.equal(terminalCompletion.nextCursor.toString(), resumedCompletion.nextCursor.toString());
        assert.equal(Chunk.some(terminalEvents, Notebook.WaitEvent.$is("content")), false);
      }),
    ),
);
