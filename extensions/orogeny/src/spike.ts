import { stripVTControlCharacters } from "node:util";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
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
  Ref,
  Schema,
  Stream,
} from "effect";
import { Jupyter } from "#o/jupyter";

class PlainTextBundle extends Schema.Opaque<PlainTextBundle>()(
  Schema.Struct({ "text/plain": Schema.String }),
) {}

class AssertionFailed extends Data.TaggedError("SpikeAssertionFailed")<{
  readonly message: string;
}> {}

class CapturedExecution extends Data.Class<{
  readonly result: Jupyter.ExecutionResult;
  readonly outputs: Chunk.Chunk<Jupyter.Output>;
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

const requirePlainText = Effect.fn("OrogenySpike.requirePlainText")(function* (
  outputs: Chunk.Chunk<Jupyter.Output>,
) {
  const value = plainText(outputs);
  if (Option.isSome(value)) return value.value;
  return yield* new AssertionFailed({
    message: "The execution did not emit a text/plain result",
  });
});

const capture = Effect.fn("OrogenySpike.capture")(function* (
  execution: Jupyter.Execution,
) {
  const { result, outputs } = yield* Effect.all(
    {
      result: execution.completion,
      outputs: pipe(
        execution.outputs,
        Stream.runCollect,
        Effect.map(Chunk.fromIterable),
      ),
    },
    { concurrency: "unbounded" },
  );
  return new CapturedExecution({ result, outputs });
});

const run = Effect.fn("OrogenySpike.run")(function* (
  kernel: Jupyter.Handle,
  code: string,
) {
  return yield* capture(yield* kernel.start(code));
});

const program = Effect.gen(function* () {
  const kernels = yield* Jupyter.Service;
  const kernel = yield* kernels.open;

  const incremental = yield* kernel.start(`
console.log("incremental-ready");
await new Promise((resolve) => setTimeout(resolve, 750));
"incremental-done";
`);
  const firstOutput = yield* Deferred.make<Jupyter.Output>();
  const capturedOutputs = yield* Ref.make(Chunk.empty<Jupyter.Output>());
  const drain = yield* pipe(
    incremental.outputs,
    Stream.runForEach((output) =>
      pipe(
        Ref.update(capturedOutputs, Chunk.append(output)),
        Effect.andThen(Deferred.succeed(firstOutput, output)),
        Effect.asVoid,
      ),
    ),
    Effect.forkChild,
  );
  const completion = yield* pipe(incremental.completion, Effect.forkChild);
  const observed = yield* pipe(
    Deferred.await(firstOutput),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(
          new AssertionFailed({
            message: "The execution did not publish incremental output",
          }),
        ),
    }),
  );
  const completionState = yield* pipe(
    Fiber.join(completion),
    Effect.timeoutOption(0),
  );
  yield* assert(
    Option.isNone(completionState),
    "The execution completed before its first output was observed",
  );
  const observedText = Jupyter.Output.$is("stream")(observed)
    ? stripVTControlCharacters(observed.text)
    : "";
  yield* assert(
    observedText.includes("incremental-ready"),
    "The first incremental output was not the expected stream event",
  );
  const incrementalResult = yield* Fiber.join(completion);
  yield* Fiber.join(drain);
  yield* assert(
    incrementalResult.status === "succeeded",
    "The incremental execution failed",
  );
  yield* Console.log("incremental output: observed before completion");

  const declaration = yield* run(kernel, "let x = 41");
  yield* assert(
    declaration.result.status === "succeeded",
    "The state declaration failed",
  );

  const persisted = yield* run(kernel, "x + 1");
  yield* assert(
    persisted.result.status === "succeeded",
    "The persisted-state execution failed",
  );
  const persistedText = yield* requirePlainText(persisted.outputs);
  const persistedValue = stripVTControlCharacters(persistedText).trim();
  yield* assert(
    persistedValue === "42",
    `Expected persisted result 42, received ${JSON.stringify(persistedText)}`,
  );
  yield* Console.log(`persistent state: ${persistedValue}`);

  const running = yield* pipe(
    capture(yield* kernel.start("while (true) {}")),
    Effect.forkChild,
  );
  yield* Effect.sleep(250);
  yield* kernel.interrupt;
  const interrupted = yield* pipe(
    Fiber.join(running),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(
          new AssertionFailed({
            message: "Interrupted execution did not settle within 5 seconds",
          }),
        ),
    }),
  );
  yield* assert(
    interrupted.result.status === "failed",
    `Expected interrupted execution to fail, received ${interrupted.result.status}`,
  );
  yield* Console.log("interrupt: settled");

  const recovered = yield* run(kernel, "1 + 1");
  yield* assert(
    recovered.result.status === "succeeded",
    "The kernel did not recover after interruption",
  );
  const recoveredText = yield* requirePlainText(recovered.outputs);
  const recoveredValue = stripVTControlCharacters(recoveredText).trim();
  yield* assert(
    recoveredValue === "2",
    `Expected recovered result 2, received ${JSON.stringify(recoveredText)}`,
  );
  yield* Console.log(`post-interrupt execution: ${recoveredValue}`);

  yield* kernel.shutdown;
  yield* Console.log("orogeny incremental kernel spike: passed");
});

const mainLayer = pipe(Jupyter.layer, Layer.provide(NodeServices.layer));

pipe(program, Effect.scoped, Effect.provide(mainLayer), NodeRuntime.runMain);
