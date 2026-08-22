import { Buffer } from "node:buffer";
import Parser from "tree-sitter";
import {
  Array as Arr,
  Chunk,
  Data,
  HashMap,
  Option,
  Order,
  pipe,
  Record as Rec,
} from "effect";
import { Capture, Match, PreparedQuery, Segment } from "./query.ts";

const validTag = /^\$[$A-Z_a-z0-9]+$/;
const validContinuation = /^[$A-Z_a-z0-9]$/;

const typescriptQuery = String.raw`
(call_expression
  function: (identifier) @injection.language
  arguments: (template_string (string_fragment) @injection.content)
  (#match? @injection.language "^\\$[$A-Z_a-z0-9]+$")
  (#offset! @injection.language 0 1 0 0)
  (#set! injection.combined)
  (#set! injection.include-children)
  (#set! orogeny.language-tag))
`;

class Injection extends Data.Class<{
  readonly language: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly includeChildren: boolean;
  readonly combined: boolean;
  readonly pattern: number;
  readonly segments: Chunk.Chunk<Segment>;
}> {}

const fallbackTag = (language: string) =>
  `$${pipe(
    Arr.fromIterable(language),
    Arr.map((character) =>
      validContinuation.test(character)
        ? character
        : `_u${character.codePointAt(0)?.toString(16) ?? "0"}_`,
    ),
    Arr.join(""),
  )}`;

export const languageTags = (catalog: HashMap.HashMap<string, string>) =>
  pipe(
    HashMap.entries(catalog),
    Arr.fromIterable,
    Arr.sort(
      pipe(
        Order.String,
        Order.mapInput(([name]: readonly [string, string]) => name),
      ),
    ),
    Arr.reduce(HashMap.empty<string, string>(), (tags, [name, canonical]) => {
      const tag = `$${name}`;
      return HashMap.set(tags, validTag.test(tag) ? tag : fallbackTag(name), canonical);
    }),
  );

export const customQuery = (language: string) =>
  language === "typescript" || language === "tsx"
    ? Option.some(typescriptQuery)
    : Option.none<string>();

const capturedLanguage = (match: Match, parent: string) =>
  HashMap.has(match.properties, "injection.parent")
    ? Option.some(parent)
    : pipe(
        match.captures,
        Chunk.findFirst(({ name }) => name === "injection.language"),
        Option.map(({ text }) => text),
        Option.orElse(() =>
          pipe(
            HashMap.get(match.properties, "injection.language"),
            Option.flatMap((language) => Option.fromNullishOr(language)),
          ),
        ),
      );

type Part = Readonly<{
  bytes: Buffer;
  segments: Chunk.Chunk<Segment>;
}>;

const concatenate = (parts: Iterable<Part>) => {
  const chunks: Array<Buffer> = [];
  const segments: Array<Segment> = [];
  let generated = 0;

  for (const part of parts) {
    if (chunks.length > 0) {
      chunks.push(Buffer.from("\n"));
      generated++;
    }

    chunks.push(part.bytes);
    for (const segment of part.segments) {
      segments.push(
        new Segment({
          generatedStart: generated + segment.generatedStart,
          generatedEnd: generated + segment.generatedEnd,
          sourceStart: segment.sourceStart,
        }),
      );
    }
    generated += part.bytes.length;
  }

  return { text: Buffer.concat(chunks).toString(), segments: Chunk.fromIterable(segments) };
};

const content = (capture: Capture, includeChildren: boolean) => {
  if (includeChildren || capture.node.children.length === 0) {
    return { text: capture.text, segments: capture.segments };
  }

  const source = Buffer.from(capture.text);
  const children = capture.node.children;
  const slices: Array<Segment> = [];

  for (const segment of capture.segments) {
    const sourceEnd = segment.sourceStart + segment.generatedEnd - segment.generatedStart;
    let cursor = segment.sourceStart;

    for (const child of children) {
      const start = Math.min(sourceEnd, Math.max(cursor, child.startIndex));
      const end = Math.min(sourceEnd, child.endIndex);

      if (cursor < start) {
        slices.push(
          new Segment({
            generatedStart: segment.generatedStart + cursor - segment.sourceStart,
            generatedEnd: segment.generatedStart + start - segment.sourceStart,
            sourceStart: cursor,
          }),
        );
      }

      cursor = Math.max(cursor, end);
      if (cursor >= sourceEnd) break;
    }

    if (cursor < sourceEnd) {
      slices.push(
        new Segment({
          generatedStart: segment.generatedStart + cursor - segment.sourceStart,
          generatedEnd: segment.generatedEnd,
          sourceStart: cursor,
        }),
      );
    }
  }

  return pipe(
    slices,
    Arr.map((slice) => {
      const bytes = source.subarray(slice.generatedStart, slice.generatedEnd);
      return {
        bytes,
        segments: Chunk.of(
          new Segment({
            generatedStart: 0,
            generatedEnd: bytes.length,
            sourceStart: slice.sourceStart,
          }),
        ),
      };
    }),
    concatenate,
  );
};

const combine = (injections: Arr.NonEmptyReadonlyArray<Injection>) => {
  const first = Arr.headNonEmpty(injections);
  const last = Arr.lastNonEmpty(injections);
  const content = pipe(
    injections,
    Arr.map(({ text, segments }) => ({ bytes: Buffer.from(text), segments })),
    concatenate,
  );

  return new Injection({
    ...first,
    ...content,
    endIndex: last.endIndex,
  });
};

export const discover = (
  catalog: HashMap.HashMap<string, string>,
  tags: HashMap.HashMap<string, string>,
  query: PreparedQuery,
  source: string,
  tree: Parser.Tree,
  parent: string,
): Chunk.Chunk<Injection> => {
  const injections = pipe(
    query.run(source, tree),
    Chunk.flatMap((match) =>
      pipe(
        capturedLanguage(match, parent),
        Option.map((language) => language.toLowerCase()),
        Option.filter(
          (language) =>
            !language.startsWith("$") || HashMap.has(match.properties, "orogeny.language-tag"),
        ),
        Option.flatMap((language) =>
          pipe(
            HashMap.get(catalog, language),
            Option.orElse(() =>
              HashMap.get(tags, language.startsWith("$") ? language : `$${language}`),
            ),
          ),
        ),
        Option.match({
          onNone: Chunk.empty,
          onSome: (language) =>
            pipe(
              match.captures,
              Chunk.filter(({ name }) => name === "injection.content"),
              Chunk.map((capture) => {
                const includeChildren = HashMap.has(
                  match.properties,
                  "injection.include-children",
                );
                const value = content(capture, includeChildren);

                return new Injection({
                  language,
                  text: value.text,
                  startIndex: capture.startIndex,
                  endIndex: capture.endIndex,
                  includeChildren,
                  combined: HashMap.has(match.properties, "injection.combined"),
                  pattern: match.pattern,
                  segments: value.segments,
                });
              }),
            ),
        }),
      ),
    ),
  );

  const combined = pipe(
    injections,
    Arr.filter(({ combined }) => combined),
    Arr.groupBy(
      ({ pattern, language, includeChildren }) => `${pattern}\0${language}\0${includeChildren}`,
    ),
    Rec.values,
    Arr.map((group) =>
      pipe(group, Arr.sortWith(({ startIndex }) => startIndex, Order.Number), combine),
    ),
  );

  return pipe(
    injections,
    Arr.filter(({ combined }) => !combined),
    Arr.appendAll(combined),
    Arr.sortWith(({ startIndex }) => startIndex, Order.Number),
    Chunk.fromIterable,
  );
};
