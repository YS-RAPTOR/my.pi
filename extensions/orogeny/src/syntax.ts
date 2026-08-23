import {
  StreamHighlighter,
  configure,
  languageCatalog,
  preloadLanguages,
} from "@ys-raptor/stream-sitter";
import type { HighlightTheme, RenderResult } from "@ys-raptor/stream-sitter";
import {
  Array as Arr,
  Chunk,
  Context,
  Data,
  Effect,
  HashMap,
  Fiber,
  HashSet,
  Layer,
  Semaphore,
  pipe,
} from "effect";
import { Config } from "#o/config";
import { CodeTheme } from "./ui/code-theme.ts";

export class OperationFailed extends Data.TaggedError("OrogenySyntax")<{
  readonly operation: string;
  readonly message: string;
}> {}

export class Highlight extends Data.Class<{
  readonly style: number;
  readonly startIndex: number;
  readonly endIndex: number;
}> {}

export class Frame extends Data.Class<{
  readonly startIndex: number;
  readonly endIndex: number;
  readonly highlights: Chunk.Chunk<Highlight>;
  readonly needsRender: boolean;
}> {}

export type Highlighter = Readonly<{
  update: (source: string) => Effect.Effect<Chunk.Chunk<Highlight>, OperationFailed>;
  updateFrame: (source: string) => Effect.Effect<Frame, OperationFailed>;
  completeFrame: () => Effect.Effect<Frame, OperationFailed>;
}>;

export type Interface = Readonly<{
  languages: HashMap.HashMap<string, string>;
  tags: HashMap.HashMap<string, string>;
  highlighter: (language: string) => Effect.Effect<Highlighter, OperationFailed>;
  highlight: (
    language: string,
    source: string,
  ) => Effect.Effect<Chunk.Chunk<Highlight>, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Syntax") {}

class Span extends Data.Class<{
  readonly style: number;
  readonly startIndex: number;
  readonly endIndex: number;
}> {}

type Opened = Readonly<{
  highlighter: Highlighter;
  settle: Effect.Effect<Chunk.Chunk<Highlight>, OperationFailed>;
}>;

const failed = (operation: string, cause: unknown) =>
  new OperationFailed({ operation, message: String(cause) });

const preload = (languages: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => preloadLanguages([...languages]),
    catch: (cause) => failed("preload Tree-sitter languages", cause),
  });

const ensure = (condition: boolean, operation: string, message: string) =>
  condition ? Effect.void : Effect.fail(failed(operation, message));

const highlights = (
  spans: ReadonlyArray<Span>,
  start = 0,
  end = Number.POSITIVE_INFINITY,
) => {
  const output: Array<Highlight> = [];
  for (const span of spans) {
    const startIndex = Math.max(start, span.startIndex);
    const endIndex = Math.min(end, span.endIndex);
    if (startIndex < endIndex) output.push(new Highlight({ ...span, startIndex, endIndex }));
  }
  return Chunk.fromIterable(output);
};

const difference = (
  previous: ReadonlyArray<Span>,
  next: ReadonlyArray<Span>,
  start: number,
  end: number,
  foreground: number,
) => {
  let previousIndex = 0;
  let nextIndex = 0;
  let position = start;
  let changedStart = Number.POSITIVE_INFINITY;
  let changedEnd = start;

  while (position < end) {
    while (
      previous[previousIndex] !== undefined &&
      previous[previousIndex]!.endIndex <= position
    )
      previousIndex++;
    while (next[nextIndex] !== undefined && next[nextIndex]!.endIndex <= position) nextIndex++;
    const left = previous[previousIndex];
    const right = next[nextIndex];
    const leftActive = left !== undefined && left.startIndex <= position;
    const rightActive = right !== undefined && right.startIndex <= position;
    const boundary = Math.min(
      end,
      left === undefined ? end : leftActive ? left.endIndex : left.startIndex,
      right === undefined ? end : rightActive ? right.endIndex : right.startIndex,
    );

    if ((leftActive ? left.style : foreground) !== (rightActive ? right.style : foreground)) {
      changedStart = Math.min(changedStart, position);
      changedEnd = boundary;
    }
    position = boundary;
  }

  return changedStart === Number.POSITIVE_INFINITY
    ? undefined
    : { start: changedStart, end: changedEnd };
};

const apply = (
  rendered: RenderResult,
  source: string,
  spans: Array<Span>,
  foreground: number,
) => {
  let frameStart = Number.POSITIVE_INFINITY;
  let frameEnd = 0;

  for (const patch of rendered.patches) {
    let first = 0;
    while (first < spans.length && spans[first]!.endIndex <= patch.replaceStart) first++;
    let last = first;
    while (last < spans.length && spans[last]!.startIndex < patch.replaceEnd) last++;

    const incoming: Array<Span> = [];
    for (let index = 0; index < patch.spans.length; index += 3)
      incoming.push(
        new Span({
          style: patch.spans[index]!,
          startIndex: patch.spans[index + 1]!,
          endIndex: patch.spans[index + 2]!,
        }),
      );

    const changed = difference(
      spans.slice(first, last),
      incoming,
      patch.replaceStart,
      patch.replaceEnd,
      foreground,
    );
    if (changed !== undefined) {
      frameStart = Math.min(frameStart, changed.start);
      frameEnd = Math.max(frameEnd, changed.end);
    }

    const replacement: Array<Span> = [];
    const left = spans[first];
    if (left !== undefined && left.startIndex < patch.replaceStart)
      replacement.push(new Span({ ...left, endIndex: patch.replaceStart }));
    replacement.push(...incoming);

    const right = spans[last - 1];
    if (right !== undefined && right.endIndex > patch.replaceEnd)
      replacement.push(new Span({ ...right, startIndex: patch.replaceEnd }));

    spans.splice(first, last - first, ...replacement);
    let index = Math.max(1, first);
    const limit = Math.min(spans.length, first + replacement.length + 2);
    while (index < limit && index < spans.length) {
      const previous = spans[index - 1]!;
      const current = spans[index]!;
      if (previous.style === current.style && previous.endIndex === current.startIndex) {
        spans[index - 1] = new Span({ ...previous, endIndex: current.endIndex });
        spans.splice(index, 1);
      } else index++;
    }
  }

  if (frameStart === Number.POSITIVE_INFINITY) {
    frameStart = Buffer.byteLength(source);
    frameEnd = frameStart;
  }
  return new Frame({
    startIndex: frameStart,
    endIndex: frameEnd,
    highlights: highlights(spans, frameStart, frameEnd),
    needsRender: source.length > 0 && rendered.needsRender,
  });
};

const open = Effect.fnUntraced(function* (
  language: string,
  preload: ReadonlyArray<string>,
  theme: HighlightTheme,
  ready: Effect.Effect<void, OperationFailed>,
): Effect.fn.Return<Opened, OperationFailed> {
  yield* ready;
  const foreground = theme.foreground;
  const native = yield* Effect.try({
    try: () => {
      const highlighter = new StreamHighlighter(language, theme);
      highlighter.preload([...preload]);
      return highlighter;
    },
    catch: (cause) => failed(`initialize ${language} syntax`, cause),
  });
  const permit = yield* Semaphore.make(1);
  const spans: Array<Span> = [];
  let source = "";

  const render = Effect.fn("Orogeny.Syntax.Highlighter.render")(function* (next: string) {
    return yield* permit.withPermit(
      Effect.gen(function* () {
        yield* ensure(next.startsWith(source), "append syntax source", "Source is not append-only");
        const rendered = yield* Effect.try({
          try: () => native.render(next.slice(source.length)),
          catch: (cause) => {
            if (native.sourceLength === Buffer.byteLength(next)) source = next;
            return failed(`render ${language} syntax`, cause);
          },
        });
        source = next;
        return apply(rendered, source, spans, foreground);
      }),
    );
  });

  const update: Highlighter["update"] = Effect.fn("Orogeny.Syntax.Highlighter.update")(
    function* (next) {
      yield* render(next);
      return highlights(spans);
    },
  );

  const completeFrame: Highlighter["completeFrame"] = Effect.fn(
    "Orogeny.Syntax.Highlighter.completeFrame",
  )(function* () {
    return yield* render(source);
  });

  const settle = Effect.gen(function* () {
    if (source.length === 0) return Chunk.empty<Highlight>();
    yield* Effect.try({
      try: () => native.waitForVerifier(),
      catch: (cause) => failed(`verify ${language} syntax`, cause),
    });
    while (true) {
      const frame = yield* render(source);
      if (!frame.needsRender) return highlights(spans);
    }
  });

  return {
    highlighter: { update, updateFrame: render, completeFrame },
    settle,
  };
});

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service;
    const treeSitter = config["tree-sitter"];
    const theme = CodeTheme.native(config.syntax.theme);
    const catalog = yield* Effect.try({
      try: languageCatalog,
      catch: (cause) => failed("load Tree-sitter language catalog", cause),
    });
    const languages = HashMap.fromIterable(
      Arr.map(catalog, ({ name, canonical }) => [name, canonical] as const),
    );
    const tags = HashMap.fromIterable(
      Arr.map(catalog, ({ tag, canonical }) => [tag, canonical] as const),
    );
    const resolve = (name: string) =>
      pipe(
        HashMap.get(languages, name.toLowerCase()),
        Effect.fromOption(() => failed("load Tree-sitter language", `Unknown language: ${name}`)),
      );
    const preloaded = yield* pipe(
      Effect.forEach(treeSitter.languages, resolve),
      Effect.map(HashSet.fromIterable),
    );
    const initial = Arr.fromIterable(preloaded);

    yield* Effect.try({
      try: () =>
        configure(treeSitter["cache-directory"], [...treeSitter["parser-directories"]]),
      catch: (cause) => failed("configure Tree-sitter", cause),
    });
    const loading = yield* pipe(preload(initial), Effect.forkScoped);

    const make = Effect.fnUntraced(function* (name: string) {
      const language = yield* resolve(name);
      const ready = HashSet.has(preloaded, language)
        ? Fiber.join(loading)
        : pipe(Fiber.join(loading), Effect.andThen(preload([language])));
      return yield* open(
        language,
        pipe(initial, Arr.append(language), HashSet.fromIterable, Arr.fromIterable),
        theme,
        ready,
      );
    });

    const highlighter: Interface["highlighter"] = Effect.fn("Orogeny.Syntax.highlighter")(
      function* (name) {
        return (yield* make(name)).highlighter;
      },
    );

    const highlight: Interface["highlight"] = Effect.fn("Orogeny.Syntax.highlight")(
      function* (name, source) {
        const syntax = yield* make(name);
        yield* syntax.highlighter.update(source);
        return yield* syntax.settle;
      },
    );

    return Service.of({ languages, tags, highlighter, highlight });
  }),
);

export * as Syntax from "./syntax.ts";
