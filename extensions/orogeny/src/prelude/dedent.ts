import formatter from "dedent";

export const dedent = formatter.withOptions({
  alignValues: true,
  escapeSpecialCharacters: false,
});

export const singleLine = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<unknown>
): string => dedent(strings, ...values).replace(/\s*\n\s*/g, " ");
