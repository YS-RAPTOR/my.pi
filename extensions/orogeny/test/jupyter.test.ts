import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Chunk, Data, Effect, Layer, Option, pipe, Stream } from "effect";
import { Jupyter } from "#o/jupyter";

class Captured extends Data.Class<{
  readonly result: Jupyter.ExecutionResult;
  readonly outputs: Chunk.Chunk<Jupyter.Output>;
}> {}

const capture = Effect.fnUntraced(function* (kernel: Jupyter.Handle, code: string) {
  const execution = yield* kernel.start(code);
  const result = yield* Effect.all(
    {
      result: execution.completion,
      outputs: pipe(execution.outputs, Stream.runCollect, Effect.map(Chunk.fromIterable)),
    },
    { concurrency: "unbounded" },
  );
  return new Captured(result);
});

const text = (captured: Captured) =>
  pipe(
    captured.outputs,
    Chunk.filter(Jupyter.Output.$is("display")),
    Chunk.map((output) => output.data["text/plain"]),
    Chunk.toReadonlyArray,
  );

test(
  "the output fence captures rapid output and prevents cross-cell attribution",
  { timeout: 20_000 },
  async () => {
    const layer = pipe(Jupyter.layer, Layer.provide(NodeServices.layer));
    await Effect.runPromise(
      pipe(
        Effect.gen(function* () {
          const kernel = yield* (yield* Jupyter.Service).open;
          const expected = Array.from({ length: 500 }, (_, index) => `FIRST-${index}`);
          const first = yield* capture(
            kernel,
            `for (let index = 0; index < 500; index++) await Deno.jupyter.display({ "text/plain": \`FIRST-\${index}\` }, { raw: true });`,
          );
          assert.equal(first.result.status, "succeeded");
          assert.deepEqual(text(first), expected);

          const second = yield* capture(
            kernel,
            `await Deno.jupyter.display({ "text/plain": "SECOND" }, { raw: true });`,
          );
          assert.equal(second.result.status, "succeeded");
          assert.deepEqual(text(second), ["SECOND"]);

          const counted = yield* capture(kernel, "42");
          const result = pipe(counted.outputs, Chunk.findFirst(Jupyter.Output.$is("display")));
          assert.equal(Option.isSome(result), true);
          if (Option.isNone(result)) return;
          assert.equal(Option.getOrUndefined(result.value.executionCount), 3);
        }),
        Effect.scoped,
        Effect.provide(layer),
      ),
    );
  },
);
