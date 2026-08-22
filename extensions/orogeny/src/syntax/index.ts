import Parser from "tree-sitter";
import languagePack from "@xberg-io/tree-sitter-language-pack";
import {
  Array as Arr,
  Cache,
  Chunk,
  Context,
  Data,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Option,
  pipe,
} from "effect";
import { Config } from "#o/config";
import {
  Candidate,
  captureCandidates,
  Highlight,
  mapCandidates,
  maskCandidates,
  resolve,
} from "./highlight.ts";
import { customQuery, discover as discoverInjections, languageTags } from "./injection.ts";
import { languages } from "./languages.generated.ts";
import { PreparedQuery, prepare } from "./query.ts";
import { composeHighlights, composeInjections } from "./source.ts";

const { configure, getHighlightsQuery, getInjectionsQuery, getLanguage, prefetch } = languagePack;

export class OperationFailed extends Data.TaggedError("OrogenySyntax")<{
  readonly operation: string;
  readonly message: string;
}> {}

class Language extends Data.Class<{
  readonly name: string;
  readonly grammar: Parser.Language;
  readonly highlights: Option.Option<PreparedQuery>;
  readonly injections: Option.Option<PreparedQuery>;
}> {}

class Frame extends Data.Class<{
  readonly language: string;
  readonly source: string;
}> {}

export type Interface = Readonly<{
  readonly languages: HashMap.HashMap<string, string>;
  readonly highlight: (
    language: string,
    source: string,
  ) => Effect.Effect<Chunk.Chunk<Highlight>, OperationFailed>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Syntax") {}

const failed = (operation: string, cause: unknown) =>
  new OperationFailed({ operation, message: String(cause) });

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = (yield* Config.Service)["tree-sitter"];

    yield* Effect.try({
      try: () => configure({ cacheDir: config["cache-directory"] }),
      catch: (cause) => failed("configure Tree-sitter", cause),
    });

    yield* Effect.try({
      try: () =>
        prefetch(
          Arr.map(config.languages, (name) => {
            const normalized = name.toLowerCase();
            return Option.getOrElse(HashMap.get(languages, normalized), () => normalized);
          }),
        ),
      catch: (cause) => failed("pre-download Tree-sitter languages", cause),
    });

    const tags = languageTags(languages);

    const cache = yield* Cache.make<string, Language, OperationFailed>({
      capacity: pipe(languages, HashMap.values, HashSet.fromIterable, HashSet.size),
      lookup: Effect.fnUntraced(function* (canonical) {
        const operation = `load Tree-sitter language ${canonical}`;
        const loaded = yield* Effect.try({
          try: () => ({
            grammar: getLanguage(canonical),
            highlights: composeHighlights(canonical, getHighlightsQuery),
            injections: pipe(
              [
                composeInjections(canonical, getInjectionsQuery),
                customQuery(canonical),
              ],
              Arr.getSomes,
              Arr.match({
                onEmpty: Option.none<string>,
                onNonEmpty: (sources) => Option.some(Arr.join(sources, "\n")),
              }),
            ),
          }),
          catch: (cause) => failed(operation, cause),
        });
        const compile = (source: Option.Option<string>) =>
          pipe(
            source,
            Option.map((source) =>
              pipe(
                prepare(loaded.grammar, source),
                Effect.mapError((cause) => failed(operation, cause)),
              ),
            ),
            Effect.transposeOption,
          );

        return new Language({
          name: canonical,
          grammar: loaded.grammar,
          highlights: yield* compile(loaded.highlights),
          injections: yield* compile(loaded.injections),
        });
      }),
    });

    const load = Effect.fnUntraced(function* (name: string) {
      const canonical = yield* pipe(
        HashMap.get(languages, name.toLowerCase()),
        Effect.fromOption(() =>
          failed("load Tree-sitter language", `Unknown language: ${name}`),
        ),
      );
      return yield* Cache.get(cache, canonical);
    });

    const discover = (language: Language, source: string, tree: Parser.Tree) =>
      pipe(
        language.injections,
        Option.match({
          onNone: Chunk.empty,
          onSome: (query) =>
            discoverInjections(languages, tags, query, source, tree, language.name),
        }),
      );

    const analyze = Effect.fnUntraced(function* (
      language: Language,
      source: string,
      depth: number,
    ) {
      return yield* Effect.try({
        try: () => {
          const parser = new Parser();
          parser.setLanguage(language.grammar);
          const tree = parser.parse(source);
          return {
            candidates: captureCandidates(language.highlights, source, tree, depth),
            injections: discover(language, source, tree),
          };
        },
        catch: (cause) => failed(`highlight ${language.name}`, cause),
      });
    });

    const walk = (
      language: Language,
      source: string,
      depth: number,
      active: HashSet.HashSet<Frame>,
    ): Effect.Effect<Chunk.Chunk<Candidate>, OperationFailed> =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const state = yield* analyze(language, source, depth);
          const frame = new Frame({ language: language.name, source });
          if (HashSet.has(active, frame)) return state.candidates;

          const next = HashSet.add(active, frame);
          let candidates = state.candidates;

          for (const injection of state.injections) {
            if (Chunk.isEmpty(injection.segments)) continue;

            const nested = yield* walk(
              yield* load(injection.language),
              injection.text,
              depth + 1,
              next,
            );
            candidates = pipe(
              candidates,
              Chunk.appendAll(maskCandidates(injection.segments, depth + 1)),
              Chunk.appendAll(mapCandidates(nested, injection.segments)),
            );
          }

          return candidates;
        }),
      );

    const highlight: Interface["highlight"] = Effect.fn("Orogeny.Syntax.highlight")(
      function* (name, source) {
        return resolve(yield* walk(yield* load(name), source, 0, HashSet.empty()));
      },
    );

    return Service.of({ languages, highlight });
  }),
);

export { Highlight } from "./highlight.ts";
export { languageTags } from "./injection.ts";
export * as Syntax from "./index.ts";
