import { Array as Arr, Context, Effect, HashMap, Layer, Order, pipe } from "effect";
import { Syntax } from "#o/syntax";

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
  const indentation = (line: string): number => {
    let index = 0;
    while (line[index] === " " || line[index] === "\\t") index++;
    return index;
  };
  const blank = (line: string): boolean => {
    const end = line.endsWith("\\r") ? line.length - 1 : line.length;
    return indentation(line) === end;
  };
  const normalize = (text: string): string => {
    const lines = text.split("\\n");
    let start = 0;
    let end = lines.length;
    while (start < end && blank(lines[start]!)) start++;
    while (end > start && blank(lines[end - 1]!)) end--;
    const body = lines.slice(start, end);
    let margin: string | undefined;

    for (const line of body) {
      if (blank(line)) continue;
      const prefix = line.slice(0, indentation(line));
      if (margin === undefined) {
        margin = prefix;
        continue;
      }
      let length = 0;
      while (length < margin.length && margin[length] === prefix[length]) length++;
      margin = margin.slice(0, length);
      if (margin === "") break;
    }

    const width = margin?.length ?? 0;
    return body
      .map((line) => blank(line) ? (line.endsWith("\\r") ? "\\r" : "") : line.slice(width))
      .join("\\n");
  };
  const makeLanguageTag = (language: string) => {
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): string =>
      normalize(strings.reduce(
        (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
        "",
      ));
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
    const languages = (yield* Syntax.Service).tags;
    const get: Interface["get"] = Effect.succeed(preludeSource(languages));
    return Service.of({ get, languages });
  }),
);

export * as Prelude from "./prelude.ts";
