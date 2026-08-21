import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Chunk, Console, Data, Effect, Layer, Option, pipe, Stream } from "effect";
import { Jupyter } from "#o/jupyter";
import { Notebook } from "#o/notebook";
import { CellOutput } from "#o/output";

const artifactRoot = mkdtempSync(join(tmpdir(), "orogeny-notebook-spike-"));

class AssertionFailed extends Data.TaggedError("NotebookSpikeAssertionFailed")<{
  readonly message: string;
}> {}

const assert = (condition: boolean, message: string): Effect.Effect<void, AssertionFailed> =>
  condition ? Effect.void : Effect.fail(new AssertionFailed({ message }));

class WaitResult extends Data.Class<{
  readonly status: Notebook.CellStatus;
  readonly text: string;
  readonly cursor: CellOutput.Cursor;
  readonly hasMore: boolean;
}> {}

const waitFor = Effect.fn("NotebookSpike.wait")(function* (
  notebooks: Notebook.Interface,
  cellId: Notebook.CellId,
  timeoutMillis: number,
) {
  const events = yield* pipe(
    notebooks.wait(
      new Notebook.WaitInput({
        cellId,
        cursor: Option.none(),
        timeoutMillis,
      }),
    ),
    Stream.runCollect,
    Effect.map(Chunk.fromIterable),
  );
  const complete = yield* pipe(
    events,
    Chunk.findFirst(Notebook.WaitEvent.$is("complete")),
    Effect.fromOption(() => new AssertionFailed({ message: "Wait did not complete" })),
  );
  const text = pipe(
    events,
    Chunk.filter(Notebook.WaitEvent.$is("content")),
    Chunk.map((event) => event.value),
    Chunk.filter(CellOutput.Content.$is("text")),
    Chunk.map((content) => content.text),
    Chunk.join(""),
  );
  return new WaitResult({
    text,
    status: complete.status,
    cursor: complete.nextCursor,
    hasMore: complete.hasMore,
  });
});

const program = Effect.gen(function* () {
  const notebooks = yield* Notebook.Service;
  const first = yield* notebooks.create(new Notebook.CreateInput({ name: Option.some("first") }));
  yield* assert(first.status === "idle", "The created notebook was not idle");
  yield* assert(first.current, "The created notebook was not current");

  const firstCell = yield* notebooks.start(
    new Notebook.StartInput({
      notebookId: Option.none(),
      code: `
let notebookValue = 40;
console.log("cell-started");
await new Promise((resolve) => setTimeout(resolve, 750));
notebookValue + 2;
`,
    }),
  );
  const running = yield* waitFor(notebooks, firstCell, 0);
  yield* assert(
    running.status === "running",
    `Expected a running cell, received ${running.status}`,
  );

  const busyFailure = yield* Effect.flip(
    notebooks.start(
      new Notebook.StartInput({
        notebookId: Option.some(first.id),
        code: "0",
      }),
    ),
  );
  yield* assert(busyFailure.message.includes("is busy"), "A busy notebook accepted another cell");

  const second = yield* notebooks.create(new Notebook.CreateInput({ name: Option.some("second") }));
  const limitFailure = yield* Effect.flip(
    notebooks.create(new Notebook.CreateInput({ name: Option.some("third") })),
  );
  yield* assert(
    limitFailure.message.includes("live notebook limit"),
    "The runtime exceeded its live notebook limit",
  );
  const secondCell = yield* notebooks.start(
    new Notebook.StartInput({
      notebookId: Option.some(second.id),
      code: "6 * 7",
    }),
  );
  const secondResult = yield* waitFor(notebooks, secondCell, 5_000);
  yield* assert(
    secondResult.status === "succeeded",
    "A cell in the second notebook did not run concurrently",
  );

  const firstResult = yield* waitFor(notebooks, firstCell, 5_000);
  yield* assert(
    firstResult.status === "succeeded",
    `The first cell ended as ${firstResult.status}`,
  );
  const firstValue = stripVTControlCharacters(firstResult.text).trim();
  yield* assert(
    firstValue.includes("42"),
    "The first notebook did not retain its final expression",
  );

  const persistedCell = yield* notebooks.start(
    new Notebook.StartInput({
      notebookId: Option.some(first.id),
      code: "notebookValue + 3",
    }),
  );
  const persisted = yield* waitFor(notebooks, persistedCell, 5_000);
  const persistedValue = stripVTControlCharacters(persisted.text).trim();
  yield* assert(persistedValue.includes("43"), "Notebook state did not persist between cells");

  const interruptedCell = yield* notebooks.start(
    new Notebook.StartInput({
      notebookId: Option.some(first.id),
      code: "while (true) {}",
    }),
  );
  yield* Effect.sleep(250);
  yield* notebooks.stopCell(interruptedCell);
  const interrupted = yield* waitFor(notebooks, interruptedCell, 0);
  yield* assert(
    interrupted.status === "interrupted",
    `Expected interrupted, received ${interrupted.status}`,
  );

  const recoveredCell = yield* notebooks.start(
    new Notebook.StartInput({
      notebookId: Option.some(first.id),
      code: "1 + 1",
    }),
  );
  const recovered = yield* waitFor(notebooks, recoveredCell, 5_000);
  yield* assert(
    recovered.status === "succeeded",
    "The notebook did not recover after interruption",
  );

  yield* notebooks.stopNotebook(first.id);
  yield* notebooks.stopNotebook(second.id);
  const listed = yield* notebooks.list;
  yield* assert(
    Chunk.every(listed, (notebook) => notebook.status === "closed"),
    "Stopping notebooks did not close them",
  );

  const journal = readFileSync(join(first.artifactPath, "notebook.jsonl"), "utf8");
  const sourceIndex = journal.indexOf('"cell_started"');
  const terminalIndex = journal.indexOf('"cell_completed"');
  const cellDirectory = join(first.artifactPath, "cells", firstCell);
  const outputs = readFileSync(join(cellDirectory, "outputs.jsonl"), "utf8");
  const streams = readFileSync(join(cellDirectory, "streams.log"), "utf8");
  yield* assert(sourceIndex >= 0, "The journal did not contain cell source");
  yield* assert(terminalIndex > sourceIndex, "Terminal status was journaled before source");
  yield* assert(!journal.includes('"cell_output"'), "Cell output remained in the notebook journal");
  yield* assert(
    outputs.split("\n").every((line) => line === "" || JSON.parse(line)),
    "The output log was not strict JSONL",
  );
  yield* assert(streams.includes("cell-started"), "The stream log was empty");

  yield* Console.log("notebook runtime: create/start/wait/stop/list passed");
  yield* Console.log("cell output: strict logs and journal separation passed");
});

const runtimeConfig = new Notebook.Config({
  artifactRoot,
  maxLiveNotebooks: 2,
  maxWaitMillis: 5 * 60 * 1_000,
  interruptGraceMillis: 5_000,
});
const mainLayer = pipe(
  Notebook.layer(runtimeConfig),
  Layer.provide(Jupyter.layer),
  Layer.provide(CellOutput.layer),
  Layer.provide(NodeServices.layer),
);

pipe(
  program,
  Effect.ensuring(Effect.sync(() => rmSync(artifactRoot, { force: true, recursive: true }))),
  Effect.provide(mainLayer),
  NodeRuntime.runMain,
);
