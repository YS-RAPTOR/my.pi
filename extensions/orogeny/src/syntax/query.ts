import { Buffer } from "node:buffer";
import Parser from "tree-sitter";
import {
  Array as Arr,
  Chunk,
  Data,
  Effect,
  HashMap,
  Option,
  pipe,
  Record as Rec,
} from "effect";

const marker = "__orogeny_";
const quoted = String.raw`"(?:\\.|[^"\\])*"`;
const expression = new RegExp(
  String.raw`\(#(has-ancestor\?|not-has-ancestor\?|not-has-parent\?|lua-match\?|not-lua-match\?|offset!|strip!)\s+(@[\w.-]+)\s+((?:${quoted}|-?\d+)(?:\s+(?:${quoted}|-?\d+))*)\s*\)`,
  "g",
);

const classes = HashMap.fromIterable<string, string>([
  ["a", "A-Za-z"],
  ["c", "\\x00-\\x1f\\x7f"],
  ["d", "0-9"],
  ["g", "\\x21-\\x7e"],
  ["l", "a-z"],
  ["p", "!-/:-@[-`{-~"],
  ["s", "\\s"],
  ["u", "A-Z"],
  ["w", "A-Za-z0-9"],
  ["x", "A-Fa-f0-9"],
  ["z", "\\x00"],
]);

type RawOperation = Readonly<{
  name: string;
  capture: string;
  args: ReadonlyArray<string | number>;
}>;

type Operation = RawOperation & Readonly<{
  matcher: Option.Option<RegExp>;
}>;

type RuntimeMatch = Parser.QueryMatch & {
  setProperties?: Readonly<Record<string, string | null>>;
};

export class Segment extends Data.Class<{
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly sourceStart: number;
}> {}

export class Capture extends Data.Class<{
  readonly name: string;
  readonly node: Parser.SyntaxNode;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
  readonly segments: Chunk.Chunk<Segment>;
}> {}

export class Match extends Data.Class<{
  readonly pattern: number;
  readonly captures: Chunk.Chunk<Capture>;
  readonly properties: HashMap.HashMap<string, string | null>;
}> {}

const luaPattern = (source: string): Effect.Effect<RegExp, string> => {
  let output = "";
  let inClass = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;

    if (character === "%") {
      const escaped = source[++index];

      if (escaped === undefined || escaped === "b" || escaped === "f") {
        return Effect.fail(`Unsupported Lua pattern: ${source}`);
      }

      const range = HashMap.get(classes, escaped.toLowerCase());

      if (Option.isNone(range)) {
        output += `\\${escaped}`;
        continue;
      }

      if (escaped !== escaped.toLowerCase()) {
        return Effect.fail(`Unsupported Lua class: %${escaped}`);
      }

      output += inClass ? range.value : `[${range.value}]`;
      continue;
    }

    if (character === "[") inClass = true;
    if (character === "]") inClass = false;

    if (inClass) output += character;
    else if (character === "-") output += "*?";
    else if (character === ".") output += "[\\s\\S]";
    else if ("{}|\\".includes(character)) output += `\\${character}`;
    else output += character;
  }

  return Effect.try({
    try: () => new RegExp(output),
    catch: (cause) => String(cause),
  });
};

const identity = (startIndex: number, endIndex: number) =>
  Chunk.of(
    new Segment({
      generatedStart: 0,
      generatedEnd: endIndex - startIndex,
      sourceStart: startIndex,
    }),
  );

const retain = (
  segments: Chunk.Chunk<Segment>,
  ranges: ReadonlyArray<readonly [number, number]>,
) => {
  const output: Array<Segment> = [];
  let generatedOffset = 0;

  for (const [rangeStart, rangeEnd] of ranges) {
    for (const segment of segments) {
      const start = Math.max(rangeStart, segment.generatedStart);
      const end = Math.min(rangeEnd, segment.generatedEnd);

      if (start >= end) continue;

      output.push(
        new Segment({
          generatedStart: generatedOffset + start - rangeStart,
          generatedEnd: generatedOffset + end - rangeStart,
          sourceStart: segment.sourceStart + start - segment.generatedStart,
        }),
      );
    }

    generatedOffset += rangeEnd - rangeStart;
  }

  return Chunk.fromIterable(output);
};

const strip = (text: string, segments: Chunk.Chunk<Segment>, matcher: RegExp) => {
  const bytes = Buffer.from(text);
  const ranges: Array<readonly [number, number]> = [];
  const chunks: Array<Buffer> = [];
  let cursor = 0;

  matcher.lastIndex = 0;

  for (const match of text.matchAll(matcher)) {
    const start = Buffer.byteLength(text.slice(0, match.index));
    const end = start + Buffer.byteLength(match[0]);

    if (cursor < start) {
      ranges.push([cursor, start]);
      chunks.push(bytes.subarray(cursor, start));
    }

    cursor = Math.max(cursor, end);
  }

  if (cursor < bytes.length) {
    ranges.push([cursor, bytes.length]);
    chunks.push(bytes.subarray(cursor));
  }

  return {
    text: Buffer.concat(chunks).toString(),
    segments: retain(segments, ranges),
  };
};

const compileOperation = (operation: RawOperation): Effect.Effect<Operation, string> => {
  if (operation.name.includes("lua-match")) {
    return pipe(
      luaPattern(String(operation.args[0] ?? "")),
      Effect.map((matcher) => ({ ...operation, matcher: Option.some(matcher) })),
    );
  }

  if (operation.name === "strip!") {
    const pattern = String(operation.args[0] ?? "");
    const flags = pattern.includes("(?m)") ? "gm" : "g";
    return pipe(
      Effect.try({
        try: () => new RegExp(pattern.replaceAll("(?m)", ""), flags),
        catch: (cause) => String(cause),
      }),
      Effect.map((matcher) => ({ ...operation, matcher: Option.some(matcher) })),
    );
  }

  return Effect.succeed({ ...operation, matcher: Option.none() });
};

const prepareSource = Effect.fnUntraced(function* (source: string) {
  const prepared = yield* Effect.try({
    try: () => {
      const operations: Array<RawOperation> = [];
      const query = source.replace(
        expression,
        (_match, name: string, capture: string, body: string) => {
          const args = pipe(
            body.matchAll(new RegExp(`${quoted}|-?\\d+`, "g")),
            Arr.fromIterable,
            Arr.map(([value]) => (value.startsWith('"') ? JSON.parse(value) : Number(value))),
          );
          operations.push({ name, capture: capture.slice(1), args });
          return `(#set! "${marker}${operations.length - 1}")`;
        },
      );
      return { operations, query };
    },
    catch: (cause) => String(cause),
  });

  return {
    query: prepared.query,
    operations: yield* Effect.forEach(prepared.operations, compileOperation),
  };
});

const accepts = (operation: Operation, match: Parser.QueryMatch) => {
  const nodes = pipe(
    match.captures,
    Arr.filter(({ name }) => name === operation.capture),
    Arr.map(({ node }) => node),
  );
  const negate = operation.name.startsWith("not-");

  if (nodes.length === 0) return negate;

  if (operation.name.includes("lua-match")) {
    return Arr.every(
      nodes,
      (node) => negate !== Option.exists(operation.matcher, (matcher) => matcher.test(node.text)),
    );
  }

  const kinds = Arr.map(operation.args, String);

  if (operation.name === "not-has-parent?") {
    return Arr.every(
      nodes,
      ({ parent }) => parent === null || !Arr.contains(kinds, parent.type),
    );
  }

  return Arr.every(nodes, (node) => {
    for (let parent = node.parent; parent !== null; parent = parent.parent) {
      if (Arr.contains(kinds, parent.type)) return !negate;
    }

    return negate;
  });
};

export class PreparedQuery extends Data.Class<{
  readonly query: Parser.Query;
  readonly operations: ReadonlyArray<Operation>;
}> {
  run(source: string, tree: Parser.Tree): Chunk.Chunk<Match> {
    const bytes = Buffer.from(source);
    const starts = [0];

    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] === 0x0a) starts.push(index + 1);
    }

    const locate = (row: number, column: number) =>
      Math.min(bytes.length, Math.max(0, (starts[row] ?? bytes.length) + column));

    const output: Array<Match> = [];

    for (const match of this.query.matches(tree.rootNode)) {
      // SAFETY: node-tree-sitter returns setProperties but omits it from QueryMatch's type.
      const properties = (match as RuntimeMatch).setProperties ?? {};

      const active = pipe(
        properties,
        Rec.keys,
        Arr.flatMap((key) => {
          if (!key.startsWith(marker)) return [];
          return pipe(
            Arr.get(this.operations, Number(key.slice(marker.length))),
            Option.toArray,
          );
        }),
      );

      const accepted = pipe(
        active,
        Arr.filter(({ name }) => name.endsWith("?")),
        Arr.every((operation) => accepts(operation, match)),
      );

      if (!accepted) continue;

      const captures = Arr.map(match.captures, ({ name, node }) => {
        let startIndex = node.startIndex;
        let endIndex = node.endIndex;
        let text = node.text;
        let segments: Chunk.Chunk<Segment> = identity(startIndex, endIndex);

        for (const operation of Arr.filter(active, (item) => item.capture === name)) {
          if (operation.name === "offset!") {
            const [sr = 0, sc = 0, er = 0, ec = 0] = Arr.map(operation.args, Number);

            startIndex = locate(node.startPosition.row + sr, node.startPosition.column + sc);
            endIndex = locate(node.endPosition.row + er, node.endPosition.column + ec);
            text = bytes.subarray(startIndex, endIndex).toString();
            segments = identity(startIndex, endIndex);
          }

          if (operation.name === "strip!" && Option.isSome(operation.matcher)) {
            const stripped = strip(text, segments, operation.matcher.value);
            text = stripped.text;
            segments = stripped.segments;
          }
        }

        return new Capture({ name, node, startIndex, endIndex, text, segments });
      });

      output.push(
        new Match({
          pattern: match.pattern,
          captures: Chunk.fromIterable(captures),
          properties: pipe(
            properties,
            Rec.toEntries,
            Arr.filter(([name]) => !name.startsWith(marker)),
            HashMap.fromIterable,
          ),
        }),
      );
    }

    return Chunk.fromIterable(output);
  }
}

export const prepare = Effect.fnUntraced(function* (
  grammar: Parser.Language,
  source: string,
) {
  const prepared = yield* prepareSource(source);
  return yield* Effect.try({
    try: () =>
      new PreparedQuery({
        query: new Parser.Query(grammar, prepared.query),
        operations: prepared.operations,
      }),
    catch: (cause) => String(cause),
  });
});
