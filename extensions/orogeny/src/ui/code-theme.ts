import type { HighlightStyle, HighlightTheme } from "@ys-raptor/stream-sitter";
import { Schema } from "effect";

const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i));

export const Style = Schema.Struct({
  foreground: Schema.optionalKey(Color),
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  underline: Schema.optionalKey(Schema.Boolean),
  strikethrough: Schema.optionalKey(Schema.Boolean),
});

export const schema = Schema.Struct({
  name: Schema.String,
  foreground: Color,
  captures: Schema.Record(Schema.String, Style),
});

export type Value = typeof schema.Type;
export type ColorMode = "truecolor" | "256color";

type CompiledStyle = Readonly<{
  readonly open: string;
  readonly close: string;
}>;

const moon = {
  blue: "#82aaff",
  blue1: "#65bcff",
  blue5: "#89ddff",
  blue6: "#b4f9f8",
  comment: "#636da6",
  cyan: "#86e1fc",
  error: "#c53b53",
  fg: "#c8d3f5",
  fgDark: "#828bb8",
  green: "#c3e88d",
  green1: "#4fd6be",
  info: "#0db9d7",
  magenta: "#c099ff",
  orange: "#ff966c",
  purple: "#fca7ea",
  red: "#ff757f",
  yellow: "#ffc777",
} as const;

// Exact foregrounds and text attributes from the active Neovim
// `tokyonight-moon` Tree-sitter groups. Backgrounds are intentionally omitted.
export const tokyoNightMoon = {
  name: "tokyonight-moon",
  foreground: moon.fg,
  captures: {
    annotation: { foreground: moon.cyan },
    attribute: { foreground: moon.cyan },
    "attribute.builtin": { foreground: moon.blue1 },
    boolean: { foreground: moon.orange },
    character: { foreground: moon.green },
    "character.printf": { foreground: moon.blue1 },
    "character.special": { foreground: moon.blue1 },
    comment: { foreground: moon.comment, italic: true },
    "comment.error": { foreground: moon.error },
    "comment.hint": { foreground: moon.green1 },
    "comment.info": { foreground: moon.info },
    "comment.note": { foreground: moon.green1 },
    "comment.todo": { foreground: moon.blue },
    "comment.warning": { foreground: moon.yellow },
    constant: { foreground: moon.orange },
    "constant.builtin": { foreground: moon.blue1 },
    "constant.macro": { foreground: moon.cyan },
    constructor: { foreground: moon.magenta },
    "constructor.tsx": { foreground: moon.blue1 },
    function: { foreground: moon.blue },
    "function.builtin": { foreground: moon.blue1 },
    "function.macro": { foreground: moon.cyan },
    keyword: { foreground: moon.purple, italic: true },
    "keyword.conditional": { foreground: moon.magenta },
    "keyword.debug": { foreground: moon.orange },
    "keyword.directive": { foreground: moon.cyan },
    "keyword.directive.define": { foreground: moon.cyan },
    "keyword.exception": { foreground: moon.magenta },
    "keyword.function": { foreground: moon.magenta },
    "keyword.import": { foreground: moon.cyan },
    "keyword.operator": { foreground: moon.blue5 },
    "keyword.repeat": { foreground: moon.magenta },
    "keyword.storage": { foreground: moon.blue1 },
    label: { foreground: moon.blue },
    markup: {},
    "markup.emphasis": { italic: true },
    "markup.environment": { foreground: moon.cyan },
    "markup.environment.name": { foreground: moon.blue1 },
    "markup.heading": { foreground: moon.blue, bold: true },
    "markup.heading.1.markdown": { foreground: moon.blue, bold: true },
    "markup.heading.2.markdown": { foreground: moon.yellow, bold: true },
    "markup.heading.3.markdown": { foreground: moon.green, bold: true },
    "markup.heading.4.markdown": { foreground: moon.green1, bold: true },
    "markup.heading.5.markdown": { foreground: moon.magenta, bold: true },
    "markup.heading.6.markdown": { foreground: moon.purple, bold: true },
    "markup.heading.7.markdown": { foreground: moon.orange, bold: true },
    "markup.heading.8.markdown": { foreground: moon.red, bold: true },
    "markup.italic": { italic: true },
    "markup.link": { foreground: moon.green1 },
    "markup.link.label": { foreground: moon.blue1 },
    "markup.link.label.symbol": { foreground: moon.magenta },
    "markup.link.url": { underline: true },
    "markup.list": { foreground: moon.blue5 },
    "markup.list.checked": { foreground: moon.green1 },
    "markup.list.markdown": { foreground: moon.orange, bold: true },
    "markup.list.unchecked": { foreground: moon.blue },
    "markup.math": { foreground: moon.blue1 },
    "markup.raw": { foreground: moon.green },
    "markup.raw.markdown_inline": { foreground: moon.blue },
    "markup.strikethrough": { strikethrough: true },
    "markup.strong": { bold: true },
    "markup.underline": { underline: true },
    module: { foreground: moon.cyan },
    "module.builtin": { foreground: moon.red },
    "namespace.builtin": { foreground: moon.red },
    none: {},
    number: { foreground: moon.orange },
    operator: { foreground: moon.blue5 },
    property: { foreground: moon.green1 },
    punctuation: { foreground: moon.blue1 },
    "punctuation.bracket": { foreground: moon.fgDark },
    "punctuation.delimiter": { foreground: moon.blue5 },
    "punctuation.special": { foreground: moon.blue5 },
    "punctuation.special.markdown": { foreground: moon.orange },
    string: { foreground: moon.green },
    "string.documentation": { foreground: moon.yellow },
    "string.escape": { foreground: moon.magenta },
    "string.regexp": { foreground: moon.blue6 },
    "string.special": { foreground: moon.blue1 },
    "string.special.url": { underline: true },
    tag: { foreground: moon.magenta },
    "tag.attribute": { foreground: moon.green1 },
    "tag.builtin": { foreground: moon.blue1 },
    "tag.delimiter": { foreground: moon.blue1 },
    "tag.delimiter.tsx": { foreground: "#6582c3" },
    "tag.javascript": { foreground: moon.red },
    "tag.tsx": { foreground: moon.red },
    type: { foreground: moon.blue1 },
    "type.builtin": { foreground: "#589ed7" },
    "type.definition": { foreground: moon.blue1 },
    "type.qualifier": { foreground: moon.purple, italic: true },
    variable: { foreground: moon.fg },
    "variable.builtin": { foreground: moon.red },
    "variable.member": { foreground: moon.green1 },
    "variable.parameter": { foreground: moon.yellow },
    "variable.parameter.builtin": { foreground: "#f4c990" },
  },
} as const satisfies Value;

const cube = [0, 95, 135, 175, 215, 255] as const;
const gray = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

const closest = (values: ReadonlyArray<number>, value: number) => {
  let selected = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < values.length; index++) {
    const next = Math.abs(value - values[index]!);
    if (next < distance) {
      selected = index;
      distance = next;
    }
  }
  return selected;
};

const distance = (
  left: readonly [number, number, number],
  right: readonly [number, number, number],
) =>
  (left[0] - right[0]) ** 2 * 0.299 +
  (left[1] - right[1]) ** 2 * 0.587 +
  (left[2] - right[2]) ** 2 * 0.114;

const RGB_MASK = 0x00ff_ffff;
const BOLD = 1 << 24;
const ITALIC = 1 << 25;
const UNDERLINE = 1 << 26;
const STRIKETHROUGH = 1 << 27;

const color = (value: string) => Number.parseInt(value.slice(1), 16);

export const native = (value: Value): HighlightTheme => ({
  foreground: color(value.foreground),
  styles: Object.entries(value.captures).map(([name, style]) => {
    const output: HighlightStyle = { name };
    if (style.foreground !== undefined) output.foreground = color(style.foreground);
    if (style.bold !== undefined) output.bold = style.bold;
    if (style.italic !== undefined) output.italic = style.italic;
    if (style.underline !== undefined) output.underline = style.underline;
    if (style.strikethrough !== undefined) output.strikethrough = style.strikethrough;
    return output;
  }),
});

const channels = (value: number) =>
  [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff] as const;

const ansi = (value: number, mode: ColorMode) => {
  const [red, green, blue] = channels(value);
  if (mode === "truecolor") return `\x1b[38;2;${red};${green};${blue}m`;

  const indexes = [closest(cube, red), closest(cube, green), closest(cube, blue)] as const;
  const cubeColor = [cube[indexes[0]]!, cube[indexes[1]]!, cube[indexes[2]]!] as const;
  const cubeIndex = 16 + 36 * indexes[0] + 6 * indexes[1] + indexes[2];
  const luminance = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
  const grayIndex = closest(gray, luminance);
  const grayColor = gray[grayIndex]!;
  const rgb = [red, green, blue] as const;
  const spread = Math.max(...rgb) - Math.min(...rgb);
  const index =
    spread < 10 && distance(rgb, [grayColor, grayColor, grayColor]) < distance(rgb, cubeColor)
      ? 232 + grayIndex
      : cubeIndex;
  return `\x1b[38;5;${index}m`;
};

const compile = (style: number, mode: ColorMode): CompiledStyle => {
  let open = ansi(style & RGB_MASK, mode);
  let close = "\x1b[39m";
  if ((style & BOLD) !== 0) {
    open += "\x1b[1m";
    close = `\x1b[22m${close}`;
  }
  if ((style & ITALIC) !== 0) {
    open += "\x1b[3m";
    close = `\x1b[23m${close}`;
  }
  if ((style & UNDERLINE) !== 0) {
    open += "\x1b[4m";
    close = `\x1b[24m${close}`;
  }
  if ((style & STRIKETHROUGH) !== 0) {
    open += "\x1b[9m";
    close = `\x1b[29m${close}`;
  }
  return { open, close };
};

export class Renderer {
  private readonly foreground: number;
  private mode: ColorMode;
  private fallback: CompiledStyle;
  private styles = new Map<number, CompiledStyle>();

  constructor(value: Value, mode: ColorMode) {
    this.foreground = color(value.foreground);
    this.mode = mode;
    this.fallback = compile(this.foreground, mode);
  }

  setColorMode(mode: ColorMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.fallback = compile(this.foreground, mode);
    this.styles.clear();
  }

  paint(value: number | undefined, text: string): string {
    if (text === "") return text;
    if (value === undefined) return `${this.fallback.open}${text}${this.fallback.close}`;

    let style = this.styles.get(value);
    if (style === undefined) {
      style = compile(value, this.mode);
      this.styles.set(value, style);
    }
    return `${style.open}${text}${style.close}`;
  }
}

export * as CodeTheme from "./code-theme.ts";
