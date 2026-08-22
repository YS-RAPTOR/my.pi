import { Array as Arr, Context, Effect, HashMap, Layer, Order, pipe } from "effect";
import { Syntax, languageTags } from "#o/syntax";

export const CODE_MIME = "application/vnd.orogeny.code+json";

export type Interface = Readonly<{
  readonly get: Effect.Effect<string>;
  readonly languages: HashMap.HashMap<string, string>;
}>;

export class Service extends Context.Service<Service, Interface>()("orogeny/Prelude") {}

const tagOrder = pipe(
  Order.String,
  Order.mapInput(([tag]: readonly [string, string]) => tag),
);

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
    const languages = languageTags((yield* Syntax.Service).languages);
    const get: Interface["get"] = Effect.succeed(preludeSource(languages));
    return Service.of({ get, languages });
  }),
);

export * as Prelude from "./prelude.ts";
