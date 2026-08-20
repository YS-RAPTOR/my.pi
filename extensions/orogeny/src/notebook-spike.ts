import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Chunk,
  Console,
  Data,
  Effect,
  Layer,
  Option,
  pipe,
  Schema,
} from "effect";
import * as Jupyter from "#o/jupyter";
import * as Notebook from "#o/notebook";

const artifactRoot = mkdtempSync(join(tmpdir(), "orogeny-notebook-spike-"));

class PlainTextBundle extends Schema.Opaque<PlainTextBundle>()(
  Schema.Struct({ "text/plain": Schema.String }),
) {}

class AssertionFailed extends Data.TaggedError("NotebookSpikeAssertionFailed")<{
  readonly message: string;
}> {}

const assert = (
  condition: boolean,
  message: string,
): Effect.Effect<void, AssertionFailed> =>
  condition ? Effect.void : Effect.fail(new AssertionFailed({ message }));

const plainText = (
  outputs: Chunk.Chunk<Jupyter.Output>,
): Option.Option<string> =>
  pipe(
    outputs,
    Chunk.filter(Jupyter.Output.$is("display")),
    Chunk.map((output) =>
      Schema.decodeUnknownOption(PlainTextBundle)(output.data),
    ),
    Chunk.filter(Option.isSome),
    Chunk.map((bundle) => bundle.value["text/plain"]),
    Chunk.head,
  );

const program = Effect.gen(function* () {
  const notebooks = yield* Notebook.Service;
  const first = yield* notebooks.create(
    new Notebook.CreateInput({ name: Option.some("first") }),
  );
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
  const running = yield* notebooks.wait(
    new Notebook.WaitInput({ cellId: firstCell, timeoutMillis: 0 }),
  );
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
  yield* assert(
    busyFailure.message.includes("is busy"),
    "A busy notebook accepted another cell",
  );

  const second = yield* notebooks.create(
    new Notebook.CreateInput({ name: Option.some("second") }),
  );
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
  const secondResult = yield* notebooks.wait(
    new Notebook.WaitInput({
      cellId: secondCell,
      timeoutMillis: 5_000,
    }),
  );
  yield* assert(
    secondResult.status === "succeeded",
    "A cell in the second notebook did not run concurrently",
  );

  const firstResult = yield* notebooks.wait(
    new Notebook.WaitInput({
      cellId: firstCell,
      timeoutMillis: 5_000,
    }),
  );
  yield* assert(
    firstResult.status === "succeeded",
    `The first cell ended as ${firstResult.status}`,
  );
  const firstValue = pipe(
    plainText(firstResult.outputs),
    Option.map((value) => stripVTControlCharacters(value).trim()),
  );
  yield* assert(
    Option.contains(firstValue, "42"),
    "The first notebook did not retain its final expression",
  );

  const persistedCell = yield* notebooks.start(
    new Notebook.StartInput({
      notebookId: Option.some(first.id),
      code: "notebookValue + 3",
    }),
  );
  const persisted = yield* notebooks.wait(
    new Notebook.WaitInput({
      cellId: persistedCell,
      timeoutMillis: 5_000,
    }),
  );
  const persistedValue = pipe(
    plainText(persisted.outputs),
    Option.map((value) => stripVTControlCharacters(value).trim()),
  );
  yield* assert(
    Option.contains(persistedValue, "43"),
    "Notebook state did not persist between cells",
  );

  const interruptedCell = yield* notebooks.start(
    new Notebook.StartInput({
      notebookId: Option.some(first.id),
      code: "while (true) {}",
    }),
  );
  yield* Effect.sleep(250);
  yield* notebooks.stopCell(interruptedCell);
  const interrupted = yield* notebooks.wait(
    new Notebook.WaitInput({
      cellId: interruptedCell,
      timeoutMillis: 0,
    }),
  );
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
  const recovered = yield* notebooks.wait(
    new Notebook.WaitInput({
      cellId: recoveredCell,
      timeoutMillis: 5_000,
    }),
  );
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

  const journal = readFileSync(
    join(first.artifactPath, "notebook.jsonl"),
    "utf8",
  );
  const sourceIndex = journal.indexOf('"cell_started"');
  const outputIndex = journal.indexOf('"cell_output"');
  const terminalIndex = journal.indexOf('"cell_completed"');
  yield* assert(sourceIndex >= 0, "The journal did not contain cell source");
  yield* assert(
    outputIndex > sourceIndex,
    "Output was journaled before source",
  );
  yield* assert(
    terminalIndex > outputIndex,
    "Terminal status was journaled before output",
  );

  yield* Console.log("notebook runtime: create/start/wait/stop/list passed");
  yield* Console.log(
    "notebook journal: source/output/terminal ordering passed",
  );
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
  Layer.provide(NodeServices.layer),
);

pipe(
  program,
  Effect.ensuring(
    Effect.sync(() => rmSync(artifactRoot, { force: true, recursive: true })),
  ),
  Effect.provide(mainLayer),
  NodeRuntime.runMain,
);
