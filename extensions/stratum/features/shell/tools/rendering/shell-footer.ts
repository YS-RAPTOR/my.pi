import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
  FooterModel,
  FooterPart,
  FooterSegment,
  ResultSource,
} from "./types.ts";

type SegmentValue = Readonly<{
  text: string;
  tone?: FooterSegment["tone"];
}>;

type Value<Input, Details> = (
  source: ResultSource<Input, Details>,
) => string | SegmentValue | undefined;

const segment = (
  value: string | SegmentValue,
  defaultTone: FooterSegment["tone"],
  trailing: boolean,
): FooterSegment =>
  typeof value === "string"
    ? { text: value, tone: defaultTone, trailing }
    : {
        text: value.text,
        tone: value.tone ?? defaultTone,
        trailing,
      };

export const item = <Input, Details>(
  extract: Value<Input, Details>,
  tone: FooterSegment["tone"] = "muted",
): FooterPart<Input, Details> => (source) => {
  const value = extract(source);
  return value === undefined ? undefined : segment(value, tone, false);
};

export const trailing = <Input, Details>(
  extract: Value<Input, Details>,
  tone: FooterSegment["tone"] = "dim",
): FooterPart<Input, Details> => (source) => {
  const value = extract(source);
  return value === undefined ? undefined : segment(value, tone, true);
};

export const compose = <Input, Details>(
  ...parts: ReadonlyArray<FooterPart<Input, Details>>
) => (source: ResultSource<Input, Details>): FooterModel => {
  const segments: Array<FooterSegment> = [];
  for (const part of parts) {
    const contribution = part(source);
    if (contribution === undefined) continue;
    if (Array.isArray(contribution)) {
      for (const current of contribution) segments.push(current);
    } else {
      segments.push(contribution as FooterSegment);
    }
  }
  return { segments };
};

class ShellFooter extends Text {
  constructor() {
    super("", 0, 0);
  }

  update(model: FooterModel, theme: Theme): void {
    const main: Array<string> = [];
    const tail: Array<string> = [];
    for (const current of model.segments) {
      const rendered = theme.fg(current.tone, current.text);
      if (current.trailing) tail.push(rendered);
      else main.push(rendered);
    }

    let text = main.join(" · ");
    if (tail.length > 0) {
      if (text.length > 0) text += "  ";
      text += tail.join("  ");
    }
    this.setText(text);
  }
}

export const render = (
  model: FooterModel,
  theme: Theme,
  previous: ShellFooter | undefined,
) => {
  const component = previous ?? new ShellFooter();
  component.update(model, theme);
  return component;
};

export const isComponent = (value: unknown): value is ShellFooter =>
  value instanceof ShellFooter;
