import { Array as Arr, Chunk, HashMap, HashSet, Option, pipe } from "effect";

export type QuerySource = (language: string) => string | null;

const inheritance = /^;\s*inherits:\s*(.+)$/m;

export const highlightInheritance = HashMap.make(
  ["arduino", Chunk.of("cpp")],
  ["cpp", Chunk.of("c")],
  ["hjson", Chunk.of("json")],
  ["hlsl", Chunk.of("cpp")],
  ["qmljs", Chunk.make("javascript", "typescript")],
  ["scss", Chunk.of("css")],
  ["slang", Chunk.of("c")],
  ["styled", Chunk.of("css")],
  ["tsx", Chunk.of("javascript")],
  ["typescript", Chunk.of("javascript")],
  ["wgsl_bevy", Chunk.of("wgsl")],
);

export const injectionInheritance = HashMap.make(
  ["fsharp_signature", Chunk.of("fsharp")],
  ["hlsl", Chunk.of("cpp")],
  ["qmljs", Chunk.of("javascript")],
  ["slang", Chunk.of("cpp")],
  ["tsx", Chunk.of("javascript")],
  ["typescript", Chunk.of("javascript")],
);

const arduinoCppHighlights = (source: string) =>
  source
    .replace("(module_name\n  (identifier) @module)\n\n", "")
    .replace(' "virtual"\n "import"\n "export"\n "module"\n', ' "virtual"\n');

const unchanged = (_language: string, source: string) => source;

const compose = (
  language: string,
  source: QuerySource,
  defaults: HashMap.HashMap<string, Chunk.Chunk<string>>,
  adapt: (language: string, source: string) => string = unchanged,
) => {
  let visited = HashSet.empty<string>();
  const queries: Array<string> = [];

  const visit = (name: string) => {
    if (HashSet.has(visited, name)) return;
    visited = HashSet.add(visited, name);

    const query = Option.fromNullishOr(source(name));
    const declared = pipe(
      query,
      Option.flatMap((source) => Option.fromNullishOr(source.match(inheritance)?.[1])),
      Option.map((parents) => pipe(parents.split(/[,\s]+/), Arr.filter(Boolean))),
      Option.getOrElse((): ReadonlyArray<string> => []),
    );
    const inherited = pipe(
      HashMap.get(defaults, name),
      Option.map(Chunk.toReadonlyArray),
      Option.getOrElse((): ReadonlyArray<string> => []),
    );

    for (const parent of Arr.appendAll(inherited, declared)) visit(parent);
    if (Option.isSome(query)) queries.push(adapt(name, query.value));
  };

  visit(language);
  return pipe(
    queries,
    Arr.match({
      onEmpty: Option.none<string>,
      onNonEmpty: (queries) => Option.some(Arr.join(queries, "\n")),
    }),
  );
};

export const composeHighlights = (language: string, source: QuerySource) =>
  compose(language, source, highlightInheritance, (name, query) => {
    if (language === "arduino" && name === "cpp") return arduinoCppHighlights(query);
    return query;
  });

export const composeInjections = (language: string, source: QuerySource) =>
  compose(language, source, injectionInheritance);
