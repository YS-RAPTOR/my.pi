import {
  type AgentToolUpdateCallback,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionContext,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
  Clock,
  Data,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Match,
  Option,
  Predicate,
} from "effect";
import { Type, type Static } from "typebox";
import { Pi } from "#s/pi";
import { Service } from "../service.ts";
import { ResourceId } from "../types.ts";
import {
  type Details,
  resultDetails,
  resultText,
} from "./open.ts";
import {
  makeShellRenderer,
  Parts,
  ShellCall,
  ShellFooter,
  ShellResult,
} from "./rendering/index.ts";

const defaultYieldAfter = 30;
const updateInterval = Duration.millis(100);

export const parameters = Type.Object({
  resource_id: Type.String({ description: "Shell resource ID" }),
  yield_after: Type.Optional(
    Type.Number({
      description: "Seconds to wait before yielding; defaults to 30",
      minimum: 0,
      default: defaultYieldAfter,
    }),
  ),
});

export type Input = Static<typeof parameters>;

class ShellWaitFailed extends Data.TaggedError("ShellWaitFailed")<{
  readonly message: string;
}> {}

const messageFrom = (error: unknown) => {
  if (
    Predicate.hasProperty(error, "message") &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
};

const commandFailure = (
  output: string,
  status: string,
  resourceId: string,
  outputFile: string | undefined,
) => {
  const body = output.length > 0 ? `${truncateTail(output).content}\n` : "";
  const location =
    outputFile === undefined ? "" : ` Full output: ${outputFile}.`;
  return new ShellWaitFailed({
    message: `${body}${status}. Resource: ${resourceId}.${location}`,
  });
};

export const renderer = makeShellRenderer<Input, Details>({
  call: ShellCall.compose(
    ShellCall.name("shell_wait"),
    ShellCall.mode(({ input }) =>
      Parts.modeFromResourceId(input?.resource_id)
    ),
  ),
  result: ShellResult.compose(
    ShellResult.output(({ details }) => details?.output),
    ShellResult.errorContent(),
    ShellResult.empty(({ options }) =>
      options.isPartial ? "waiting for output…" : "(no output)"
    ),
    ShellResult.preview(5),
  ),
  footer: ShellFooter.compose(
    ShellFooter.item(Parts.processStatus),
    ShellFooter.trailing(({ details }) =>
      details?.truncated === true
        ? { text: "output truncated", tone: "warning" }
        : undefined
    ),
    ShellFooter.trailing(({ input, details }) =>
      details?.resourceId ?? input?.resource_id
    ),
  ),
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const fileSystem = yield* FileSystem.FileSystem;
    const shell = yield* Service;

    const readOutput = Effect.fn("Shell.Tools.Wait.__readOutput")(
      function* (
        resourceId: ResourceId,
        outputFile: string | undefined,
        pty: boolean,
      ) {
        if (!pty && outputFile !== undefined) {
          return yield* fileSystem.readFileString(outputFile);
        }
        return (yield* shell.snapshot(resourceId, null)).text;
      },
    );

    yield* contributions.tool({
      name: "shell_wait",
      label: "Wait for Shell",
      description: `Wait for a shell resource to complete, yielding after yield_after seconds. Returns the resource's current output and status. yield_after defaults to ${defaultYieldAfter}. STDIO output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; complete output remains in its output log. PTY output is the complete visible terminal capture.`,
      promptSnippet:
        "Wait for a persistent shell resource and read its latest output",
      parameters,
      executionMode: "parallel",
      execute: (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) => Effect.gen(function* () {
        const resourceId = new ResourceId({ value: input.resource_id });
        const initial = yield* shell.inspect(resourceId);
        const outputFile = initial.outputFile;
        const pty = outputFile === undefined;
        const yieldAfter = input.yield_after ?? defaultYieldAfter;
        const startedAt = yield* Clock.currentTimeMillis;
        const deadline = startedAt + yieldAfter * 1000;
        let lastOutput = "";
        let lastRemaining = yieldAfter;

        const snapshot = readOutput(resourceId, outputFile, pty);
        const emit = Effect.fn("Shell.Tools.Wait.__emit")(function* (
          output: string,
          remainingSeconds: number,
        ) {
          if (onUpdate === undefined) return;
          const now = yield* Clock.currentTimeMillis;
          const details = resultDetails(
            "waiting",
            resourceId.value,
            pty,
            output,
            outputFile,
            remainingSeconds,
            (now - startedAt) / 1000,
          );
          yield* Effect.sync(() =>
            onUpdate({
              content: [{ type: "text", text: details.output }],
              details,
            }),
          );
        });

        const poll = Effect.gen(function* () {
          yield* emit(lastOutput, lastRemaining);
          while (true) {
            yield* Effect.sleep(updateInterval);
            const now = yield* Clock.currentTimeMillis;
            const remainingSeconds = Math.max(
              0,
              Math.ceil((deadline - now) / 1000),
            );
            const current = yield* Effect.option(snapshot);
            const output = Option.isSome(current)
              ? current.value
              : lastOutput;
            if (output !== lastOutput || remainingSeconds !== lastRemaining) {
              lastOutput = output;
              lastRemaining = remainingSeconds;
              yield* emit(output, remainingSeconds);
            }
          }
        });

        const completed = yield* Effect.scoped(
          Effect.gen(function* () {
            const polling = yield* Effect.forkScoped(poll);
            const waited = yield* shell.wait(resourceId, yieldAfter);
            yield* Fiber.interrupt(polling);
            return waited;
          }),
        );
        const output = yield* snapshot;
        const endedAt = yield* Clock.currentTimeMillis;
        const summary = yield* shell.inspect(resourceId);

        const failure = Match.value(summary.lifecycle).pipe(
          Match.tags({
            failed: ({ message }) => Option.some(message),
            completed: ({ exitCode, signal }) =>
              exitCode !== null && exitCode !== 0
                ? Option.some(`Command exited with code ${exitCode}`)
                : signal === null
                  ? Option.none()
                  : Option.some(`Command exited after signal ${signal}`),
            draining: () => Option.none(),
            running: () => Option.none(),
          }),
          Match.exhaustive,
        );
        if (Option.isSome(failure)) {
          return yield* commandFailure(
            output,
            failure.value,
            resourceId.value,
            outputFile,
          );
        }

        const details = resultDetails(
          completed ? "completed" : "yielded",
          resourceId.value,
          pty,
          output,
          outputFile,
          0,
          (endedAt - startedAt) / 1000,
        );
        return {
          content: [{ type: "text" as const, text: resultText(details) }],
          details,
        };
      }).pipe(
        Effect.withSpan("Shell.Tools.Wait.execute"),
        Effect.mapError((error) =>
          Predicate.isTagged(error, "ShellWaitFailed")
            ? error
            : new ShellWaitFailed({ message: messageFrom(error) }),
        ),
      ),
      renderCall: renderer.renderCall,
      renderResult: renderer.renderResult,
    });
  }),
);
