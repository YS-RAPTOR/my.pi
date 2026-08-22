import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import * as Pi from "@earendil-works/pi-coding-agent";
import {
  Chunk,
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  pipe,
  Schema,
  Stream,
  String as Str,
} from "effect";
import { Jupyter } from "#o/jupyter";
import { Notebook } from "#o/notebook";
import { CellOutput } from "#o/output";
import { Prelude } from "#o/prelude";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const runtimeLayer = (artifactRoot: string) =>
  pipe(
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

const fixture = async <A, E>(body: (notebooks: Notebook.Interface) => Effect.Effect<A, E>) => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "orogeny-notebook-test-"));

  try {
    return await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          return yield* body(yield* Notebook.Service);
        }),
        Effect.provide(runtimeLayer(artifactRoot)),
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

test("create initializes the generated language prelude", { timeout: 20_000 }, () =>
  fixture((notebooks) =>
    Effect.gen(function* () {
      const notebook = yield* notebooks.create();
      const cell = yield* notebooks.start(
        new Notebook.StartInput({
          notebookId: Option.some(notebook.id),
          code: "console.log($ts`const answer: number = 42;`)",
        }),
      );
      yield* awaitTerminal(notebooks, cell);
      const events = yield* collectWait(notebooks, cell, Option.none(), 5_000);
      assert.equal(completion(events).status, "succeeded");
      assert.match(text(events), /const answer: number = 42;\n$/);
    }),
  ),
);

test("list filters names by case-insensitive containment and status exactly", () =>
  fixture((notebooks) =>
    Effect.gen(function* () {
      const primary = yield* notebooks.create(
        new Notebook.CreateInput({ name: Option.some("Analysis Primary") }),
      );
      yield* notebooks.stopNotebook(primary.id);
      const archive = yield* notebooks.create(
        new Notebook.CreateInput({ name: Option.some("analysis archive") }),
      );
      yield* notebooks.stopNotebook(archive.id);
      const notes = yield* notebooks.create(
        new Notebook.CreateInput({ name: Option.some("notes") }),
      );

      const byName = yield* notebooks.list(
        new Notebook.ListInput({ name: Option.some("ANALY"), status: Option.none() }),
      );
      assert.deepEqual(
        new Set(Chunk.toReadonlyArray(Chunk.map(byName, (notebook) => notebook.id))),
        new Set([primary.id, archive.id]),
      );

      const combined = yield* notebooks.list(
        new Notebook.ListInput({
          name: Option.some("primary"),
          status: Option.some("closed"),
        }),
      );
      assert.deepEqual(
        Chunk.toReadonlyArray(Chunk.map(combined, (notebook) => notebook.id)),
        [primary.id],
      );

      const idle = yield* notebooks.list(
        new Notebook.ListInput({ name: Option.none(), status: Option.some("idle") }),
      );
      assert.deepEqual(Chunk.toReadonlyArray(Chunk.map(idle, (notebook) => notebook.id)), [
        notes.id,
      ]);
      assert.equal(Chunk.size(yield* notebooks.list()), 3);
    }),
  ),
);

test("discovery restores the existing notebook and cell objects", { timeout: 20_000 }, async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "orogeny-discovery-test-"));

  try {
    const stored = await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          const notebooks = yield* Notebook.Service;
          const notebook = yield* notebooks.create();
          const cell = yield* notebooks.start(
            new Notebook.StartInput({
              notebookId: Option.some(notebook.id),
              code: 'console.log("discovered output")',
            }),
          );
          yield* awaitTerminal(notebooks, cell);
          yield* notebooks.stopNotebook(notebook.id);
          return { notebook, cell };
        }),
        Effect.provide(runtimeLayer(artifactRoot)),
      ),
    );

    await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          const notebooks = yield* Notebook.Service;
          const listed = yield* notebooks.list();
          const notebook = pipe(
            listed,
            Chunk.findFirst((value) => value.id === stored.notebook.id),
          );
          assert.equal(Option.isSome(notebook), true);
          if (Option.isNone(notebook)) return;
          assert.equal(notebook.value.status, "closed");

          const events = yield* collectWait(notebooks, stored.cell, Option.none(), 5_000);
          assert.equal(completion(events).status, "succeeded");
          assert.match(text(events), /discovered output/);
          yield* notebooks.stopCell(stored.cell);
          yield* notebooks.stopNotebook(stored.notebook.id);
        }),
        Effect.provide(runtimeLayer(artifactRoot)),
      ),
    );
  } finally {
    rmSync(artifactRoot, { force: true, recursive: true });
  }
});

test("discovery defaults unfinished cells without inspecting cell files", async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "orogeny-recovery-test-"));
  const notebookId = Schema.decodeUnknownSync(Notebook.NotebookId)(`nb_${crypto.randomUUID()}`);
  const cellId = Schema.decodeUnknownSync(Notebook.CellId)(`cell_${crypto.randomUUID()}`);
  const directory = join(artifactRoot, notebookId);
  const journal = join(directory, "notebook.jsonl");
  const timestamp = new Date().toISOString();

  try {
    mkdirSync(directory);
    writeFileSync(
      journal,
      [
        { sequence: 0, timestamp, event: "notebook_created", name: null },
        { sequence: 1, timestamp, event: "cell_started", cell_id: cellId, code: "await never" },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          const notebooks = yield* Notebook.Service;
          const listed = yield* notebooks.list();
          assert.equal(Chunk.size(listed), 1);
          assert.equal(Chunk.headUnsafe(listed).status, "closed");
          yield* notebooks.stopCell(cellId);
        }),
        Effect.provide(runtimeLayer(artifactRoot)),
      ),
    );

    assert.doesNotMatch(readFileSync(journal, "utf8"), /cell_completed/);
  } finally {
    rmSync(artifactRoot, { force: true, recursive: true });
  }
});

test(
  "discovery reads inherited output through its session-local symlink",
  { timeout: 20_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "orogeny-inherited-test-"));
    const ownerRoot = join(root, "owner", "notebooks");
    const childRoot = join(root, "child", "notebooks");

    try {
      const stored = await Effect.runPromise(
        pipe(
          Effect.gen(function* () {
            const notebooks = yield* Notebook.Service;
            const notebook = yield* notebooks.create();
            const cell = yield* notebooks.start(
              new Notebook.StartInput({
                notebookId: Option.some(notebook.id),
                code: 'console.log("inherited output")',
              }),
            );
            yield* awaitTerminal(notebooks, cell);
            yield* notebooks.stopNotebook(notebook.id);
            return { notebook, cell };
          }),
          Effect.provide(runtimeLayer(ownerRoot)),
        ),
      );
      const canonicalPath = stored.notebook.artifactPath;
      const inheritedPath = join(childRoot, stored.notebook.id);
      mkdirSync(childRoot, { recursive: true });
      symlinkSync(relative(childRoot, canonicalPath), inheritedPath, "dir");
      const journalPath = join(canonicalPath, "notebook.jsonl");
      const journal = readFileSync(journalPath, "utf8");

      await Effect.runPromise(
        pipe(
          Effect.gen(function* () {
            const notebooks = yield* Notebook.Service;
            const listed = yield* notebooks.list();
            assert.equal(Chunk.size(listed), 1);
            const inherited = Chunk.headUnsafe(listed);
            assert.equal(inherited.id, stored.notebook.id);
            assert.equal(inherited.status, "closed");
            assert.equal(inherited.artifactPath, inheritedPath);

            const events = yield* collectWait(notebooks, stored.cell, Option.none(), 5_000);
            assert.equal(completion(events).status, "succeeded");
            assert.match(text(events), /inherited output/);

            const failure = yield* Effect.flip(
              notebooks.start(
                new Notebook.StartInput({
                  notebookId: Option.some(stored.notebook.id),
                  code: "1 + 1",
                }),
              ),
            );
            assert.equal(failure.operation, "use notebook kernel");
            yield* notebooks.stopCell(stored.cell);
            yield* notebooks.stopNotebook(stored.notebook.id);
          }),
          Effect.provide(runtimeLayer(childRoot)),
        ),
      );

      assert.equal(lstatSync(inheritedPath).isSymbolicLink(), true);
      assert.equal(realpathSync(inheritedPath), realpathSync(canonicalPath));
      assert.equal(readFileSync(journalPath, "utf8"), journal);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("discovery ignores dangling notebook links without hiding valid entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "orogeny-dangling-test-"));
  const canonicalRoot = join(root, "canonical");
  const childRoot = join(root, "child", "notebooks");
  const validId = Schema.decodeUnknownSync(Notebook.NotebookId)(`nb_${crypto.randomUUID()}`);
  const missingId = Schema.decodeUnknownSync(Notebook.NotebookId)(`nb_${crypto.randomUUID()}`);
  const canonicalPath = join(canonicalRoot, validId);
  const timestamp = new Date().toISOString();

  try {
    mkdirSync(canonicalPath, { recursive: true });
    mkdirSync(childRoot, { recursive: true });
    writeFileSync(
      join(canonicalPath, "notebook.jsonl"),
      `${JSON.stringify({
        sequence: 0,
        timestamp,
        event: "notebook_created",
        name: null,
      })}\n`,
    );
    symlinkSync(relative(childRoot, canonicalPath), join(childRoot, validId), "dir");
    symlinkSync(
      relative(childRoot, join(canonicalRoot, missingId)),
      join(childRoot, missingId),
      "dir",
    );

    await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          const notebooks = yield* Notebook.Service;
          const listed = yield* notebooks.list();
          assert.deepEqual(Chunk.toReadonlyArray(Chunk.map(listed, (value) => value.id)), [
            validId,
          ]);
        }),
        Effect.provide(runtimeLayer(childRoot)),
      ),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  "wait returns immediately when captured output exactly fills the delivery page",
  { timeout: 20_000 },
  () =>
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

        const terminalEvents = yield* collectWait(
          notebooks,
          cell,
          Option.some(immediateCompletion.nextCursor),
          5_000,
        );
        const terminalCompletion = completion(terminalEvents);
        assert.equal(terminalCompletion.status, "succeeded");
        assert.equal(terminalCompletion.hasMore, false);
        assert.equal(Chunk.some(terminalEvents, Notebook.WaitEvent.$is("content")), false);
      }),
    ),
);

test(
  "wait paginates rapid text and image output without losing the tail",
  { timeout: 20_000 },
  () =>
    fixture((notebooks) =>
      Effect.gen(function* () {
        const notebook = yield* notebooks.create();
        const cell = yield* notebooks.start(
          new Notebook.StartInput({
            notebookId: Option.some(notebook.id),
            code: `
const pagedLines = Array.from({ length: 2001 }, () => "x").join("\\n");
await Deno.jupyter.display({ "text/plain": pagedLines }, { raw: true });
await Deno.jupyter.display({ "text/plain": "text before image\\n" }, { raw: true });
await Deno.jupyter.display({ "image/png": "${TINY_PNG}", "text/plain": "one pixel" }, { raw: true });
await Deno.jupyter.display({ "text/plain": "text after image\\n" }, { raw: true });
`,
          }),
        );
        yield* awaitTerminal(notebooks, cell);

        const linesPage = yield* collectWait(notebooks, cell, Option.none(), 5_000);
        const linesComplete = completion(linesPage);
        assert.equal(linesComplete.status, "succeeded");
        assert.equal(linesComplete.nextCursor.toString(), "oc1:o0:l2000");
        assert.equal(linesComplete.hasMore, true);
        assert.equal(
          pipe(text(linesPage), Str.linesWithSeparators, Chunk.fromIterable, Chunk.size),
          2_000,
        );
        assert.equal(Chunk.some(content(linesPage), CellOutput.Content.$is("image")), false);

        const imagePage = yield* collectWait(
          notebooks,
          cell,
          Option.some(linesComplete.nextCursor),
          5_000,
        );
        const imageComplete = completion(imagePage);
        const imageContent = content(imagePage);
        assert.equal(imageComplete.status, "succeeded");
        assert.equal(imageComplete.nextCursor.toString(), "oc1:o3:l0");
        assert.equal(imageComplete.hasMore, true);
        assert.equal(Chunk.size(imageContent), 4);

        const remainingLine = Chunk.getUnsafe(imageContent, 0);
        const beforeImage = Chunk.getUnsafe(imageContent, 1);
        const annotation = Chunk.getUnsafe(imageContent, 2);
        const image = Chunk.getUnsafe(imageContent, 3);
        assert.ok(CellOutput.Content.$is("text")(remainingLine));
        assert.equal(remainingLine.text, "x");
        assert.ok(CellOutput.Content.$is("text")(beforeImage));
        assert.equal(beforeImage.text, "text before image\n");
        assert.ok(CellOutput.Content.$is("text")(annotation));
        assert.match(annotation.text, /^\[Image\]\(<.*artifact_/);
        assert.match(annotation.text, /\{image\/png,text\/plain\}\n$/);
        assert.ok(CellOutput.Content.$is("image")(image));
        assert.equal(image.mimeType, "image/png");
        assert.notEqual(image.data.length, 0);

        const tailPage = yield* collectWait(
          notebooks,
          cell,
          Option.some(imageComplete.nextCursor),
          5_000,
        );
        const tailComplete = completion(tailPage);
        assert.equal(tailComplete.status, "succeeded");
        assert.equal(tailComplete.nextCursor.toString(), "oc1:o4:l0");
        assert.equal(tailComplete.hasMore, false);
        assert.equal(text(tailPage), "text after image\n");
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
        const completedEarly = yield* pipe(
          Fiber.await(progressiveWait),
          Effect.timeoutOption("50 millis"),
        );
        assert.equal(Option.isNone(completedEarly), true);

        const progressiveEvents = yield* Fiber.join(progressiveWait);
        const progressiveCompletion = completion(progressiveEvents);
        const progressiveText = text(progressiveEvents);
        assert.equal(progressiveCompletion.status, "succeeded");
        assert.ok(progressiveText.indexOf("progress-before") >= 0);
        assert.ok(
          progressiveText.indexOf("progress-after") > progressiveText.indexOf("progress-before"),
        );

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
        assert.equal(
          terminalCompletion.nextCursor.toString(),
          resumedCompletion.nextCursor.toString(),
        );
        assert.equal(Chunk.some(terminalEvents, Notebook.WaitEvent.$is("content")), false);
      }),
    ),
);
