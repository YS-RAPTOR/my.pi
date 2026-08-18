import { stripVTControlCharacters } from "node:util";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Console,
  Data,
  Effect,
  Fiber,
  Layer,
  Option,
  pipe,
  Schema,
} from "effect";
import { Jupyter } from "#o/jupyter";

class PlainTextBundle extends Schema.Opaque<PlainTextBundle>()(
  Schema.Struct({ "text/plain": Schema.String }),
) {}

class AssertionFailed extends Data.TaggedError("SpikeAssertionFailed")<{
  readonly message: string;
}> {}

const assert = (
  condition: boolean,
  message: string,
): Effect.Effect<void, AssertionFailed> =>
  condition ? Effect.void : Effect.fail(new AssertionFailed({ message }));

const plainText = (
  result: Jupyter.Kernel.ExecutionResult,
): Option.Option<string> => {
  for (const output of result.outputs) {
    if (!Jupyter.Kernel.Output.$is("display")(output)) continue;
    const bundle = Schema.decodeUnknownOption(PlainTextBundle)(output.data);
    if (Option.isSome(bundle)) return Option.some(bundle.value["text/plain"]);
  }
  return Option.none();
};

const requirePlainText = Effect.fn("OrogenySpike.requirePlainText")(
  function* (result: Jupyter.Kernel.ExecutionResult) {
    const value = plainText(result);
    if (Option.isSome(value)) return value.value;
    return yield* new AssertionFailed({
      message: "The execution did not emit a text/plain result",
    });
  },
);

const program = Effect.gen(function* () {
  const kernels = yield* Jupyter.Kernel.Service;
  const kernel = yield* kernels.open();

  const declaration = yield* kernel.execute("let x = 41");
  yield* assert(
    declaration.status === "succeeded",
    "The state declaration failed",
  );

  const persisted = yield* kernel.execute("x + 1");
  yield* assert(
    persisted.status === "succeeded",
    "The persisted-state execution failed",
  );
  const persistedText = yield* requirePlainText(persisted);
  const persistedValue = stripVTControlCharacters(persistedText).trim();
  yield* assert(
    persistedValue === "42",
    `Expected persisted result 42, received ${JSON.stringify(persistedText)}`,
  );
  yield* Console.log(`persistent state: ${persistedValue}`);

  const running = yield* kernel
    .execute("while (true) {}")
    .pipe(Effect.forkChild);
  yield* Effect.sleep(250);
  yield* kernel.interrupt;
  const interrupted = yield* Fiber.join(running).pipe(
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
    interrupted.status === "failed",
    `Expected interrupted execution to fail, received ${interrupted.status}`,
  );
  yield* Console.log("interrupt: settled");

  const recovered = yield* kernel.execute("1 + 1");
  yield* assert(
    recovered.status === "succeeded",
    "The kernel did not recover after interruption",
  );
  const recoveredText = yield* requirePlainText(recovered);
  const recoveredValue = stripVTControlCharacters(recoveredText).trim();
  yield* assert(
    recoveredValue === "2",
    `Expected recovered result 2, received ${JSON.stringify(recoveredText)}`,
  );
  yield* Console.log(`post-interrupt execution: ${recoveredValue}`);

  yield* kernel.shutdown;
  yield* Console.log("orogeny transport spike: passed");
});

const mainLayer = Jupyter.layer.pipe(Layer.provide(NodeServices.layer));

pipe(
  program,
  Effect.scoped,
  Effect.provide(mainLayer),
  NodeRuntime.runMain,
);
