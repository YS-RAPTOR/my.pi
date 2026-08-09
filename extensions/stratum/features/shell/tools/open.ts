import {
  type AgentToolUpdateCallback,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionContext,
  formatSize,
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
  Path,
  Predicate,
} from "effect";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Pi } from "#s/pi";
import { Service } from "../service.ts";
import { Open } from "../types.ts";
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
  cmd: Type.String({ description: "Command to execute" }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory; defaults to the current working directory",
    }),
  ),
  env: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Null()]),
      {
        description:
          "Environment overrides; null removes an inherited variable",
      },
    ),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description: "Open a PTY-backed terminal; defaults to false",
      default: false,
    }),
  ),
  yield_after: Type.Optional(
    Type.Number({
      description: "Seconds to wait before yielding; defaults to 30",
      minimum: 0,
      default: defaultYieldAfter,
    }),
  ),
});

export type Input = Static<typeof parameters>;

export const detailsSchema = Type.Object({
  phase: Type.Union([
    Type.Literal("waiting"),
    Type.Literal("completed"),
    Type.Literal("yielded"),
  ]),
  resourceId: Type.String(),
  mode: Type.Union([Type.Literal("stdio"), Type.Literal("pty")]),
  output: Type.String(),
  outputFile: Type.Optional(Type.String()),
  remainingSeconds: Type.Number(),
  durationSeconds: Type.Number(),
  truncated: Type.Boolean(),
  totalLines: Type.Number(),
  outputLines: Type.Number(),
});

export type Details = Static<typeof detailsSchema>;

type Phase = Details["phase"];

class ShellOpenFailed extends Data.TaggedError("ShellOpenFailed")<{
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

const modeOf = (pty: boolean): Details["mode"] =>
  pty ? "pty" : "stdio";

const lineCount = (text: string) => {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
};

export const resultDetails = (
  phase: Phase,
  resourceId: string,
  pty: boolean,
  output: string,
  outputFile: string | undefined,
  remainingSeconds: number,
  durationSeconds: number,
): Details => {
  const captured = pty
    ? {
        content: output,
        truncated: false,
        totalLines: lineCount(output),
        outputLines: lineCount(output),
      }
    : truncateTail(output);
  return {
    phase,
    resourceId,
    mode: modeOf(pty),
    output: captured.content,
    ...(outputFile === undefined ? {} : { outputFile }),
    remainingSeconds,
    durationSeconds,
    truncated: captured.truncated,
    totalLines: captured.totalLines,
    outputLines: captured.outputLines,
  };
};

export const resultText = (details: Details) => {
  const output = details.output.length > 0 ? details.output : "(no output)";
  const status =
    details.phase === "yielded"
      ? `Yielded after ${details.durationSeconds.toFixed(1)} seconds; process is still running.`
      : `Process completed in ${details.durationSeconds.toFixed(1)} seconds.`;
  const location =
    details.outputFile === undefined
      ? ""
      : ` Output log: ${details.outputFile}.`;
  const truncation = details.truncated
    ? ` Output truncated to ${details.outputLines} of ${details.totalLines} lines (${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} line limit); full output remains at ${details.outputFile}.`
    : "";
  return `${output}\n\n[${status} Resource: ${details.resourceId}.${location}${truncation}]`;
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
  return new ShellOpenFailed({
    message: `${body}${status}. Resource: ${resourceId}.${location}`,
  });
};

const truncateEnv = (value: string | null) => {
  if (value === null) return "unset";
  return value.length > 5 ? `${value.slice(0, 5)}…` : value;
};

const environment = (env: Input["env"]) => {
  if (env === undefined) return;
  const entries: Array<string> = [];
  for (const [name, value] of Object.entries(env)) {
    entries.push(`${name}=${truncateEnv(value)}`);
  }
  return entries.length === 0 ? undefined : entries.join(" ");
};

export const renderer = makeShellRenderer<Input, Details>({
  call: ShellCall.compose(
    ShellCall.name("shell_open"),
    ShellCall.mode(({ input }) => input?.pty === true ? "pty" : "stdio"),
    ShellCall.primary(({ input }) => input?.cmd),
    ShellCall.metadata("cwd", ({ input, cwd }) => {
      if (input?.cwd === undefined) return;
      const requested = resolve(cwd, input.cwd);
      return requested === resolve(cwd) ? undefined : requested;
    }),
    ShellCall.metadata("env", ({ input }) => environment(input?.env)),
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
    ShellFooter.trailing(({ details }) => details?.resourceId),
  ),
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Pi.Contributions.Service;
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const shell = yield* Service;

    const readOutput = Effect.fn("Shell.Tools.Open.__readOutput")(
      function* (
        resourceId: import("../types.ts").ResourceId,
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
      name: "shell_open",
      label: "Open Shell",
      description: `Open a persistent shell resource, wait up to yield_after seconds, and return its current output. cmd is required. cwd defaults to the current working directory, pty defaults to false, and yield_after defaults to ${defaultYieldAfter}. STDIO output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; the complete log remains available at the returned output path. PTY output is the complete visible terminal capture.`,
      promptSnippet:
        "Open a persistent STDIO or PTY shell and wait for initial output",
      parameters,
      executionMode: "parallel",
      execute: (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) => Effect.gen(function* () {
        const callback = yield* Pi.Host.Callback;
        const currentCwd = yield* callback.session.cwd;
        const cwd =
          input.cwd === undefined
            ? currentCwd
            : paths.resolve(currentCwd, input.cwd);
        const pty = input.pty ?? false;
        const yieldAfter = input.yield_after ?? defaultYieldAfter;
        const opened = yield* shell.open(
          new Open({
            cmd: input.cmd,
            cwd,
            ...(input.env === undefined ? {} : { env: input.env }),
            pty,
          }),
        );
        const resourceId = opened.resourceId.value;
        const startedAt = yield* Clock.currentTimeMillis;
        const deadline = startedAt + yieldAfter * 1000;
        let lastOutput = "";
        let lastRemaining = yieldAfter;

        const snapshot = readOutput(opened.resourceId, opened.outputFile, pty);
        const emit = Effect.fn("Shell.Tools.Open.__emit")(function* (
          output: string,
          remainingSeconds: number,
        ) {
          if (onUpdate === undefined) return;
          const now = yield* Clock.currentTimeMillis;
          const details = resultDetails(
            "waiting",
            resourceId,
            pty,
            output,
            opened.outputFile,
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
            const waited = yield* shell.wait(opened.resourceId, yieldAfter);
            yield* Fiber.interrupt(polling);
            return waited;
          }),
        );
        const output = yield* snapshot;
        const endedAt = yield* Clock.currentTimeMillis;
        const summary = yield* shell.inspect(opened.resourceId);

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
            resourceId,
            opened.outputFile,
          );
        }

        const details = resultDetails(
          completed ? "completed" : "yielded",
          resourceId,
          pty,
          output,
          opened.outputFile,
          0,
          (endedAt - startedAt) / 1000,
        );
        return {
          content: [{ type: "text" as const, text: resultText(details) }],
          details,
        };
      }).pipe(
        Effect.withSpan("Shell.Tools.Open.execute"),
        Effect.mapError((error) =>
          Predicate.isTagged(error, "ShellOpenFailed")
            ? error
            : new ShellOpenFailed({ message: messageFrom(error) }),
        ),
      ),
      renderCall: renderer.renderCall,
      renderResult: renderer.renderResult,
    });
  }),
);
