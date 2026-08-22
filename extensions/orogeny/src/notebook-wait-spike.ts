import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Pi from "@earendil-works/pi-coding-agent";
import {
  Chunk,
  Console,
  Data,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  pipe,
  Stream,
  String as Str,
} from "effect";
import { Jupyter } from "#o/jupyter";
import { Notebook } from "#o/notebook";
import { CellOutput } from "#o/output";
import { Prelude } from "#o/prelude";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const artifactRoot = mkdtempSync(join(tmpdir(), "orogeny-notebook-wait-spike-"));

class AssertionFailed extends Data.TaggedError("NotebookWaitSpikeAssertionFailed")<{
  readonly message: string;
}> {}

class Page extends Data.Class<{
  readonly content: Chunk.Chunk<CellOutput.Content>;
  readonly status: Notebook.CellStatus;
  readonly cursor: CellOutput.Cursor;
  readonly hasMore: boolean;
}> {}

const assert = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new AssertionFailed({ message }));

const read = Effect.fnUntraced(function* (
  notebooks: Notebook.Interface,
  cellId: Notebook.CellId,
  cursor: Option.Option<CellOutput.Cursor> = Option.none(),
  timeoutMillis = 5_000,
): Effect.fn.Return<Page, Notebook.OperationFailed | AssertionFailed> {
  const events = yield* pipe(
    notebooks.wait(new Notebook.WaitInput({ cellId, cursor, timeoutMillis })),
    Stream.runCollect,
    Effect.map(Chunk.fromIterable),
  );
  const completions = pipe(events, Chunk.filter(Notebook.WaitEvent.$is("complete")));
  yield* assert(Chunk.size(completions) === 1, "Wait did not emit exactly one completion");
  yield* assert(
    Notebook.WaitEvent.$is("complete")(Chunk.lastUnsafe(events)),
    "Wait completion was not the final event",
  );
  const complete = Chunk.headUnsafe(completions);
  return new Page({
    content: pipe(
      events,
      Chunk.filter(Notebook.WaitEvent.$is("content")),
      Chunk.map((event) => event.value),
    ),
    status: complete.status,
    cursor: complete.nextCursor,
    hasMore: complete.hasMore,
  });
});

const settle = Effect.fnUntraced(function* (
  notebooks: Notebook.Interface,
  cellId: Notebook.CellId,
  cursor: Option.Option<CellOutput.Cursor> = Option.none(),
): Effect.fn.Return<void, Notebook.OperationFailed | AssertionFailed> {
  const page = yield* read(notebooks, cellId, cursor);
  if (page.status !== "running") return;
  return yield* settle(notebooks, cellId, Option.some(page.cursor));
});

const program = Effect.gen(function* () {
  const notebooks = yield* Notebook.Service;
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
  yield* settle(notebooks, cell);

  const linesPage = yield* read(notebooks, cell);
  const linesText = pipe(
    linesPage.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((content) => content.text),
    Chunk.join(""),
  );
  const logicalLines = pipe(linesText, Str.linesWithSeparators, Chunk.fromIterable, Chunk.size);
  yield* assert(logicalLines === 2_000, `Expected 2,000 lines, received ${logicalLines}`);
  yield* assert(
    linesPage.cursor.toString() === "oc1:o0:l2000",
    `Unexpected line cursor: ${linesPage.cursor}`,
  );
  yield* assert(linesPage.hasMore, "The image page was not left unread");

  const imagePage = yield* read(notebooks, cell, Option.some(linesPage.cursor));
  const imageContent = pipe(
    imagePage.content,
    Chunk.map((value) =>
      CellOutput.Content.$is("text")(value)
        ? { type: "text" as const, value: value.text }
        : { type: "image" as const, mimeType: value.mimeType, dataLength: value.data.length },
    ),
    Chunk.toReadonlyArray,
  );
  yield* assert(
    imageContent.length === 3,
    `Expected three image-page blocks, received ${imageContent.length}`,
  );
  const [remaining, annotation, image] = imageContent;
  yield* assert(
    remaining?.type === "text" && remaining.value === "x",
    "Remaining line was missing",
  );
  yield* assert(
    annotation?.type === "text" && annotation.value.startsWith("[Image]("),
    "Image annotation was missing",
  );
  yield* assert(
    image?.type === "image" && image.mimeType === "image/png",
    "PNG content block was missing",
  );
  yield* assert(
    imagePage.cursor.toString() === "oc1:o2:l0",
    `Unexpected image cursor: ${imagePage.cursor}`,
  );
  yield* assert(!imagePage.hasMore, "Output remained after the image");

  const boundaryCell = yield* notebooks.start(
    new Notebook.StartInput({
      notebookId: Option.some(notebook.id),
      code: `
await Deno.jupyter.display({ "image/png": "${TINY_PNG}", "text/plain": "one pixel" }, { raw: true });
await Deno.jupyter.display({ "text/plain": "text after image\\n" }, { raw: true });
`,
    }),
  );
  yield* settle(notebooks, boundaryCell);

  const boundaryPage = yield* read(notebooks, boundaryCell);
  const boundaryContent = pipe(
    boundaryPage.content,
    Chunk.map((value) =>
      CellOutput.Content.$is("text")(value)
        ? { type: "text" as const, value: value.text }
        : { type: "image" as const, mimeType: value.mimeType, dataLength: value.data.length },
    ),
    Chunk.toReadonlyArray,
  );
  yield* assert(
    boundaryContent.length === 2,
    "Image boundary page did not contain annotation and image",
  );
  yield* assert(
    boundaryPage.cursor.toString() === "oc1:o1:l0",
    `Unexpected boundary cursor: ${boundaryPage.cursor}`,
  );
  yield* assert(boundaryPage.hasMore, "Text after the image was not left unread");

  const afterImagePage = yield* read(notebooks, boundaryCell, Option.some(boundaryPage.cursor));
  const afterImageText = pipe(
    afterImagePage.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((content) => content.text),
    Chunk.join(""),
  );
  yield* assert(
    afterImageText === "text after image\n",
    "Text after the image was not delivered next",
  );
  yield* assert(
    afterImagePage.cursor.toString() === "oc1:o2:l0",
    `Unexpected tail cursor: ${afterImagePage.cursor}`,
  );
  yield* assert(!afterImagePage.hasMore, "Output remained after the tail page");

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

  const partialPage = yield* read(notebooks, partialCell, Option.none(), 0);
  const partialText = pipe(
    partialPage.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((content) => content.text),
    Chunk.join(""),
  );
  yield* assert(partialPage.status === "running", "Partial-line wait did not report running");
  yield* assert(
    partialPage.cursor.position.byte !== undefined,
    "Partial-line wait did not return a byte cursor",
  );
  yield* assert(
    partialText.endsWith("partial-loading"),
    "Partial-line wait did not return its committed prefix",
  );

  const continuedPage = yield* read(notebooks, partialCell, Option.some(partialPage.cursor));
  const continuedText = pipe(
    continuedPage.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((content) => content.text),
    Chunk.join(""),
  );
  yield* assert(continuedText === "done\n", "Partial-line wait repeated or lost its continuation");
  yield* assert(
    continuedPage.cursor.toString() === "oc1:o1:l0",
    `Unexpected continuation cursor: ${continuedPage.cursor}`,
  );

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
  yield* settle(notebooks, oversizedCell);

  const oversizedPage = yield* read(notebooks, oversizedCell);
  const oversizedText = pipe(
    oversizedPage.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((content) => content.text),
    Chunk.join(""),
  );
  yield* assert(
    oversizedPage.cursor.toString() === `oc1:o0:l0:b${Pi.DEFAULT_MAX_BYTES}`,
    `Unexpected oversized-line cursor: ${oversizedPage.cursor}`,
  );
  yield* assert(
    Buffer.byteLength(oversizedText) === Pi.DEFAULT_MAX_BYTES,
    "Oversized-line page exceeded its byte limit",
  );
  yield* assert(oversizedPage.hasMore, "Oversized-line tail was not left unread");

  const oversizedTail = yield* read(notebooks, oversizedCell, Option.some(oversizedPage.cursor));
  const oversizedTailText = pipe(
    oversizedTail.content,
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((content) => content.text),
    Chunk.join(""),
  );
  yield* assert(
    oversizedTailText === "é".repeat(5),
    "Oversized line did not resume at its byte cursor",
  );
  yield* assert(
    oversizedTail.cursor.toString() === "oc1:o1:l0",
    `Unexpected oversized tail cursor: ${oversizedTail.cursor}`,
  );

  yield* Console.log(
    "notebook wait spike: line pagination and image delivery",
    JSON.stringify(
      {
        firstRead: {
          logicalLines,
          cursor: linesPage.cursor.toString(),
          hasMore: linesPage.hasMore,
          status: linesPage.status,
        },
        secondRead: {
          content: imageContent,
          cursor: imagePage.cursor.toString(),
          hasMore: imagePage.hasMore,
          status: imagePage.status,
        },
        imageBoundaryRead: {
          content: boundaryContent,
          cursor: boundaryPage.cursor.toString(),
          hasMore: boundaryPage.hasMore,
          status: boundaryPage.status,
        },
        afterImageRead: {
          text: afterImageText,
          cursor: afterImagePage.cursor.toString(),
          hasMore: afterImagePage.hasMore,
          status: afterImagePage.status,
        },
        openPartialLine: {
          text: partialText,
          cursor: partialPage.cursor.toString(),
          hasMore: partialPage.hasMore,
          status: partialPage.status,
        },
        continuedPartialLine: {
          text: continuedText,
          cursor: continuedPage.cursor.toString(),
          hasMore: continuedPage.hasMore,
          status: continuedPage.status,
        },
        oversizedLine: {
          bytes: Buffer.byteLength(oversizedText),
          cursor: oversizedPage.cursor.toString(),
          hasMore: oversizedPage.hasMore,
          status: oversizedPage.status,
        },
        oversizedLineTail: {
          text: oversizedTailText,
          cursor: oversizedTail.cursor.toString(),
          hasMore: oversizedTail.hasMore,
          status: oversizedTail.status,
        },
      },
      null,
      2,
    ),
  );
});

const mainLayer = pipe(
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
  Layer.provide(Prelude.layer),
  Layer.provide(NodeServices.layer),
);

pipe(
  program,
  Effect.ensuring(Effect.sync(() => rmSync(artifactRoot, { force: true, recursive: true }))),
  Effect.provide(mainLayer),
  NodeRuntime.runMain,
);
