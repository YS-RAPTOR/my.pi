import hljs from "highlight.js";
import {
  Array as Arr,
  Context,
  Data,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Option,
  Order,
  pipe,
  Result,
} from "effect";

export const CODE_MIME = "application/vnd.orogeny.code+json";

type HighlightLanguage = NonNullable<ReturnType<typeof hljs.getLanguage>>;

class Language extends Data.Class<{
  readonly name: string;
  readonly definition: HighlightLanguage;
}> {}

export type Interface = Readonly<{
  readonly get: Effect.Effect<string>;
  readonly languages: HashMap.HashMap<string, string>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "orogeny/Prelude",
) {}

const validTag = /^\$[$A-Z_a-z0-9]+$/;
const validContinuation = /^[$A-Z_a-z0-9]$/;
const tagOrder = pipe(
  Order.String,
  Order.mapInput(([tag]: readonly [string, string]) => tag),
);

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

const discoverLanguages = () => {
  const names = pipe(hljs.listLanguages(), Arr.sort(Order.String));
  const definitions = pipe(
    names,
    Arr.filterMap((name) => {
      const definition = hljs.getLanguage(name);
      return definition === undefined
        ? Result.failVoid
        : Result.succeed(new Language({ name, definition }));
    }),
  );

  const ownerOf = (definition: HighlightLanguage) =>
    pipe(
      definitions,
      Arr.findFirst((language) => language.definition === definition),
      Option.map((language) => language.name),
    );

  const candidates = pipe(
    definitions,
    Arr.flatMap((language) =>
      pipe(
        [language.name, ...(language.definition.aliases ?? [])],
        Arr.filterMap((alias) => {
          const name = alias.toLowerCase();
          const tag = `$${name}`;
          return validTag.test(tag)
            ? Result.succeed([tag, name] as const)
            : Result.failVoid;
        }),
      ),
    ),
  );

  const discovered = pipe(
    candidates,
    Arr.reduce(HashMap.empty<string, string>(), (languages, [tag, name]) =>
      pipe(
        Option.fromUndefinedOr(hljs.getLanguage(name)),
        Option.flatMap(ownerOf),
        Option.match({
          onNone: () => languages,
          onSome: (owner) => HashMap.set(languages, tag, owner),
        }),
      ),
    ),
  );

  const represented = HashSet.fromIterable(HashMap.values(discovered));
  return pipe(
    names,
    Arr.reduce(discovered, (languages, name) =>
      HashSet.has(represented, name)
        ? languages
        : HashMap.set(languages, fallbackTag(name), name),
    ),
  );
};

const preludeSource = (languages: HashMap.HashMap<string, string>) => {
  const entries = pipe(HashMap.entries(languages), Arr.fromIterable, Arr.sort(tagOrder));
  const bindings = pipe(
    entries,
    Arr.map(([tag]) => `  ${tag},`),
    Arr.join("\n"),
  );
  const values = pipe(
    entries,
    Arr.map(([, language]) => `    makeLanguageTag(${JSON.stringify(language)}),`),
    Arr.join("\n"),
  );

  return `const [
${bindings}
] = (() => {
  const nativeDisplay = Deno.jupyter.display.bind(Deno.jupyter);
  const makeLanguageTag = (language: string) => {
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): string =>
      strings.reduce(
        (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
        "",
      );
    const display = (text: string): Promise<void> =>
      nativeDisplay({
        ${JSON.stringify(CODE_MIME)}: { language, code: text },
        "text/plain": text,
      }, { raw: true });
    return Object.freeze(Object.assign(tag, { display }));
  };
  return [
${values}
  ] as const;
})();`;
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const languages = yield* Effect.sync(discoverLanguages);
    const source = preludeSource(languages);
    const get: Interface["get"] = Effect.succeed(source);
    return Service.of({ get, languages });
  }),
);

export * as Prelude from "./prelude.ts";
