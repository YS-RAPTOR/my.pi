import { Array as Arr, Effect, HashMap, Layer, Order, pipe } from "effect";
import { Prelude } from "#o/prelude";
import { CODE_MIME } from "../output/mime.ts";
import { Service } from "./index.ts";

const tagOrder = pipe(
  Order.String,
  Order.mapInput(([tag]: readonly [string, string]) => tag),
);

const source = (languages: HashMap.HashMap<string, string>) => {
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

  return Prelude.dedent`
    const [
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
    })();

    const $img = Object.freeze({
      display: async (image: Blob): Promise<void> => {
        if (!image.type.startsWith("image/")) {
          throw new TypeError("$img.display expects a Blob with an image MIME type");
        }
        const bytes = new Uint8Array(await image.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
        }
        await Deno.jupyter.display({ [image.type]: btoa(binary) }, { raw: true });
      },
    });
  `;
};

const docs = (languages: HashMap.HashMap<string, string>): ReadonlyArray<Prelude.Doc> => [
  {
    name: "$img",
    kind: "namespace",
    summary: "Notebook image helpers.",
    signature: Prelude.dedent`
      const $img: Readonly<{
        display(image: Blob): Promise<void>;
      }>
    `,
    description: Prelude.singleLine`
      Helpers for working with Web API image values in notebooks. Images are not
      displayed until \`display()\` is called explicitly.
    `,
    errors: [],
    examples: ["Object.keys($img)"],
    keywords: ["image", "blob", "display", "namespace"],
  },
  {
    name: "$img.display",
    kind: "function",
    summary: "Display an image Blob in notebook output.",
    signature: "$img.display(image: Blob): Promise<void>",
    description: Prelude.singleLine`
      Render an image \`Blob\` as Jupyter notebook output using the \`Blob\`'s MIME type.
      The image becomes visible to you only when this function is called.
    `,
    errors: ["Throws when the Blob does not have an image MIME type."],
    examples: [
      Prelude.dedent`
        const result = await pi.read({ path: "screenshot.png" })
        if (result.image) await $img.display(result.image)
      `,
    ],
    keywords: ["image", "blob", "display", "render", "jupyter"],
  },
  ...pipe(
    HashMap.entries(languages),
    Arr.fromIterable,
    Arr.sort(tagOrder),
    Arr.map(([tag, language]) => ({
      name: tag,
      kind: "language" as const,
      summary: `Create and display ${language} source.`,
      signature: Prelude.dedent`
        const ${tag}: {
          (strings: TemplateStringsArray, ...values: unknown[]): string;
          display(source: string): Promise<void>;
        }
      `,
      description: Prelude.singleLine`
      A tagged template for ${language} source. It interpolates values, removes blank
      framing lines, dedents common leading whitespace, and returns a string. \`display()\`
      renders the source as syntax-highlighted notebook output.
    `,
      errors: [],
      examples: [`const source = ${tag}\`...\``, `await ${tag}.display(source)`],
      keywords: [language, tag.slice(1), "language", "syntax", "display"],
    })),
  ),
];

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const syntax = yield* Service;
    const preludes = yield* Prelude.Service;
    yield* preludes.register({
      name: "syntax",
      source: source(syntax.tags),
      docs: docs(syntax.tags),
    });
  }),
);
