import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  Chunk,
  Clock,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  Stream,
  pipe,
} from "effect";
import { type Static, Type } from "typebox";
import { Config } from "#o/config";
import { Notebook } from "#o/notebook";
import { CellOutput } from "#o/output";
import { Session } from "#o/session";
import { Syntax } from "#o/syntax";
import { Outline, OutputView, Status, statusColor, type StatusPhase } from "#o/ui";
import { Pi } from "@ys-raptor/pi-effect";

const DEFAULT_TIMEOUT_MILLIS = 10_000;
const COUNTDOWN_UPDATE_MILLIS = 100;

export const parameters = Type.Object(
  {
    cellId: Type.Union([Type.String(), Type.Null()], {
      description: "Full cell_... ID to observe, or null to sleep for timeoutMillis",
    }),
    cursor: Type.Optional(
      Type.String({ description: "Output cursor returned by an earlier wait call" }),
    ),
    timeoutMillis: Type.Optional(
      Type.Integer({
        description: "Maximum time to wait for cell status; defaults to 10000 milliseconds",
        minimum: 0,
      }),
    ),
  },
  { additionalProperties: false },
);

export type Input = Static<typeof parameters>;

const outputSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({
    type: Type.Literal("code"),
    language: Type.String(),
    text: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
  }),
]);

export const detailsSchema = Type.Object({
  cellId: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([
    Type.Literal("waiting"),
    Type.Literal("sleeping"),
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("interrupted"),
  ]),
  nextCursor: Type.Optional(Type.String()),
  hasMore: Type.Optional(Type.Boolean()),
  remainingSeconds: Type.Optional(Type.Number()),
  sleptMillis: Type.Optional(Type.Number()),
  output: Type.Array(outputSchema),
});

export type Details = Static<typeof detailsSchema>;
type Output = Details["output"][number];
type Completion = Extract<Notebook.WaitEvent, { readonly _tag: "complete" }>;

type RendererState = { view?: WaitView };

class WaitFailed extends Data.TaggedError("WaitFailed")<{
  readonly message: string;
}> {}

const empty = (): Component => new Container();
const firstLine = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() ?? "";

const serialize = (content: Chunk.Chunk<CellOutput.Content>): Array<Output> =>
  pipe(
    content,
    Chunk.map(
      (value): Output =>
        pipe(
          Match.value(value),
          Match.when({ _tag: "text" }, ({ text }) => ({ type: "text" as const, text })),
          Match.when({ _tag: "code" }, ({ language, text }) => ({
            type: "code" as const,
            language,
            text,
          })),
          Match.when({ _tag: "image" }, ({ data, mimeType }) => ({
            type: "image" as const,
            data,
            mimeType,
          })),
          Match.exhaustive,
        ),
    ),
    Chunk.toArray,
  );

const modelContent = (details: Details): AgentToolResult<Details>["content"] => {
  if (details.cellId === null)
    return [
      {
        type: "text",
        text:
          details.status === "sleeping"
            ? `Sleeping for ${details.remainingSeconds ?? 0} more seconds.`
            : `Slept for ${details.sleptMillis ?? 0} milliseconds.`,
      },
    ];

  const cursor = details.nextCursor === undefined ? "pending" : details.nextCursor;
  const summary = pipe(
    Match.value(details),
    Match.when({ status: "waiting" }, ({ cellId }) => `Waiting for cell ${cellId}.`),
    Match.orElse(
      ({ cellId, status, hasMore }) =>
        `Cell ${cellId} is ${status}. Next cursor: ${cursor}. More output: ${hasMore === true ? "yes" : "no"}.`,
    ),
  );
  const content: AgentToolResult<Details>["content"] = [{ type: "text", text: summary }];

  for (const output of details.output) {
    if (output.type === "image") {
      content.push(output);
      continue;
    }
    const previous = content.at(-1);
    const separator = content.length === 1 && previous?.type === "text" ? "\n\n" : "";
    if (previous?.type === "text") previous.text += separator + output.text;
    else content.push({ type: "text", text: output.text });
  }
  return content;
};

class WaitView implements Component {
  private readonly body: OutputView;
  private outline: Outline | undefined;

  constructor(syntax: Syntax.Interface, codeTheme: Config.Value["syntax"]["theme"], theme: Theme) {
    this.body = new OutputView(syntax, codeTheme, theme);
  }

  update(options: {
    readonly theme: Theme;
    readonly phase: StatusPhase;
    readonly cellId: string;
    readonly status: string;
    readonly output: ReadonlyArray<Output>;
    readonly expanded: boolean;
    readonly invalidate: () => void;
  }) {
    const hasOutput = options.output.length > 0;
    const status = new Status(options.theme, {
      phase: options.phase,
      text: firstLine(options.status),
    });
    const center = hasOutput
      ? this.body.update({
          theme: options.theme,
          output: options.output,
          expanded: options.expanded,
          invalidate: options.invalidate,
        })
      : status;
    const outline = {
      theme: options.theme,
      phase: options.phase,
      top: new Text(options.theme.fg(statusColor(options.phase), `WAIT · ${options.cellId}`), 0, 0),
      center,
    };
    this.outline = new Outline(hasOutput ? { ...outline, bottom: status } : outline);
    return this;
  }

  render(width: number): string[] {
    return this.outline?.render(width) ?? [];
  }

  invalidate(): void {
    this.outline?.invalidate();
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service;
    const contributions = yield* Pi.Contributions.Service;
    const sessions = yield* Session.Service;
    const syntax = yield* Syntax.Service;

    yield* contributions.tool<typeof parameters, Details, RendererState, WaitFailed>({
      name: "wait",
      label: "Wait or Sleep",
      description:
        "Wait for a notebook cell and return its status, bounded output captured since the supplied cursor, next cursor, and whether more output remains. Output may include text, highlighted code, and images. Pass null for cellId to sleep instead. timeoutMillis defaults to 10000; set it to 0 for an immediate poll or no-op sleep.",
      promptSnippet: "Wait for a notebook cell, or sleep when cellId is null",
      promptGuidelines: [
        "After push succeeds, use wait with its returned cell ID to receive the cell's status and captured output.",
        "Pass wait's next cursor back as cursor on the next wait call so output is not repeated.",
        "Call wait again while the cell is running or while more output remains. A wait timeout does not stop the cell; use stop explicitly when needed.",
        "Use a null cell ID to sleep for timeoutMillis without observing a notebook cell.",
      ],
      parameters,
      executionMode: "parallel",
      renderShell: "self",
      execute: Effect.fn("Orogeny.Tools.Wait.execute")(function* (
        _toolCallId: string,
        input: Input,
        _signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback<Details> | undefined,
        _context: ExtensionContext,
      ) {
        const timeoutMillis = Math.min(
          input.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS,
          config["max-wait-ms"],
        );
        const cellId =
          input.cellId === null
            ? null
            : yield* Schema.decodeUnknownEffect(Notebook.CellId)(input.cellId).pipe(
                Effect.mapError(() => new WaitFailed({ message: "The cell ID is invalid." })),
              );
        const startedAt = yield* Clock.currentTimeMillis;
        const deadline = startedAt + timeoutMillis;
        const output = yield* Ref.make(Chunk.empty<CellOutput.Content>());
        const completion = yield* Ref.make<Option.Option<Completion>>(Option.none());

        const remaining = pipe(
          Clock.currentTimeMillis,
          Effect.map((now) => Math.max(0, Math.ceil((deadline - now) / 1_000))),
        );
        const update = Effect.fnUntraced(function* (remainingSeconds: number) {
          if (onUpdate === undefined) return;
          const details: Details =
            cellId === null
              ? {
                  cellId: null,
                  status: "sleeping",
                  remainingSeconds,
                  sleptMillis: timeoutMillis,
                  output: [],
                }
              : {
                  cellId,
                  status: "waiting",
                  remainingSeconds,
                  output: serialize(yield* Ref.get(output)),
                };
          yield* Effect.sync(() => onUpdate({ content: modelContent(details), details }));
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const initial = yield* remaining;
            yield* update(initial);
            if (onUpdate !== undefined)
              yield* pipe(
                Effect.gen(function* () {
                  let previous = initial;
                  while (previous > 0) {
                    yield* Effect.sleep(Duration.millis(COUNTDOWN_UPDATE_MILLIS));
                    const current = yield* remaining;
                    if (current === previous) continue;
                    previous = current;
                    yield* update(current);
                  }
                }),
                Effect.forkScoped,
              );

            if (cellId === null) {
              yield* Effect.sleep(Duration.millis(timeoutMillis));
              return;
            }

            const notebooks = yield* sessions.notebook.pipe(
              Effect.mapError(
                () => new WaitFailed({ message: "The notebook session is unavailable." }),
              ),
            );
            const cursor = yield* input.cursor === undefined
              ? Effect.succeed(Option.none<CellOutput.Cursor>())
              : Schema.decodeUnknownEffect(CellOutput.Cursor.FromString)(input.cursor).pipe(
                  Effect.map(Option.some),
                  Effect.mapError(
                    () => new WaitFailed({ message: "The output cursor is invalid." }),
                  ),
                );
            yield* pipe(
              notebooks.wait(new Notebook.WaitInput({ cellId, cursor, timeoutMillis })),
              Stream.runForEach((event) =>
                pipe(
                  Match.value(event),
                  Match.when({ _tag: "complete" }, (value) =>
                    Ref.set(completion, Option.some(value)),
                  ),
                  Match.when({ _tag: "content" }, ({ value }) =>
                    pipe(
                      Ref.update(output, Chunk.append(value)),
                      Effect.andThen(remaining),
                      Effect.flatMap(update),
                    ),
                  ),
                  Match.exhaustive,
                ),
              ),
              Effect.mapError(
                (error) =>
                  new WaitFailed({
                    message: pipe(
                      Match.value(error.operation),
                      Match.when("find cell", () => "Cell not found."),
                      Match.when("read cell output", () => error.message),
                      Match.orElse(() => "The cell could not be observed."),
                    ),
                  }),
              ),
            );
          }),
        );

        if (cellId === null) {
          const details: Details = {
            cellId: null,
            status: "succeeded",
            sleptMillis: timeoutMillis,
            output: [],
          };
          return { content: modelContent(details), details };
        }

        const completed = yield* Effect.fromOption(
          () => new WaitFailed({ message: "The wait ended without a status." }),
        )(yield* Ref.get(completion));
        const details: Details = {
          cellId,
          status: completed.status,
          nextCursor: completed.nextCursor.toString(),
          hasMore: completed.hasMore,
          output: serialize(yield* Ref.get(output)),
        };
        return { content: modelContent(details), details };
      }),
      renderCall(input: Partial<Input> | undefined, theme, context) {
        if (!context.isPartial || context.executionStarted) return empty();
        const phase: StatusPhase = context.argsComplete ? "running" : "streaming";
        const sleeping = input?.cellId === null;
        const cellId = sleeping ? "sleep" : firstLine(input?.cellId ?? "") || "cell";
        const timeout = Math.ceil((input?.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS) / 1_000);
        const view = (context.state.view ??= new WaitView(syntax, config.syntax.theme, theme));
        return view.update({
          theme,
          phase,
          cellId: phase === "streaming" && cellId !== "cell" ? `${cellId}…` : cellId,
          status:
            phase === "streaming"
              ? "receiving cell ID…"
              : `${sleeping ? "sleeping" : "waiting"} · ${timeout}s`,
          output: [],
          expanded: context.expanded,
          invalidate: context.invalidate,
        });
      },
      renderResult(result: AgentToolResult<Details>, options, theme, context) {
        const view = (context.state.view ??= new WaitView(syntax, config.syntax.theme, theme));
        const details = result.details;
        const sleeping = details?.cellId === null || context.args?.cellId === null;
        const cellId = sleeping
          ? "sleep"
          : (details?.cellId ?? (firstLine(context.args?.cellId ?? "") || "cell"));

        if (context.isError || details === undefined) {
          const content = result.content.find((part) => part.type === "text");
          return view.update({
            theme,
            phase: "error",
            cellId,
            status: content?.text ?? "wait failed",
            output: [],
            expanded: options.expanded,
            invalidate: context.invalidate,
          });
        }

        const phase: StatusPhase = pipe(
          Match.value(details.status),
          Match.whenOr("waiting", "sleeping", "running", () => "running" as const),
          Match.when("succeeded", () => "done" as const),
          Match.orElse(() => "error" as const),
        );
        const status =
          details.cellId === null
            ? details.status === "sleeping"
              ? `sleeping · ${details.remainingSeconds ?? 0}s`
              : `slept · ${details.sleptMillis ?? 0}ms`
            : pipe(
                Match.value(details),
                Match.when(
                  { status: "waiting" },
                  ({ remainingSeconds }) => `waiting · ${remainingSeconds ?? 0}s`,
                ),
                Match.orElse(({ status, output, hasMore, nextCursor }) =>
                  [
                    status,
                    output.length === 0 ? "no new output" : undefined,
                    hasMore === true ? "more output" : undefined,
                    nextCursor,
                  ]
                    .filter((value) => value !== undefined)
                    .join(" · "),
                ),
              );

        return view.update({
          theme,
          phase,
          cellId,
          status,
          output: details.output,
          expanded: options.expanded,
          invalidate: context.invalidate,
        });
      },
    });
  }),
);

export * as Wait from "./wait.ts";
