import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  keyHint,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as ShellFooter from "./shell-footer.ts";
import type {
  FooterModel,
  ResultFragment,
  ResultModel,
  ResultPart,
  ResultSource,
} from "./types.ts";

type Value<Input, Details, Output> = (
  source: ResultSource<Input, Details>,
) => Output | undefined;

export const output = <Input, Details>(
  extract: Value<Input, Details, string>,
): ResultPart<Input, Details> => (source) => {
  const value = extract(source);
  return value === undefined ? undefined : { output: value };
};

export const errorContent = <Input, Details>(): ResultPart<Input, Details> =>
  (source) => {
    if (!source.isError) return;
    const lines: Array<string> = [];
    for (const part of source.result.content) {
      if (part.type === "text") lines.push(part.text);
    }
    return { output: lines.join("\n") };
  };

export const empty = <Input, Details>(
  extract: Value<Input, Details, string>,
): ResultPart<Input, Details> => (source) => {
  const value = extract(source);
  return value === undefined ? undefined : { emptyText: value };
};

export const preview = <Input, Details>(
  lines: number,
): ResultPart<Input, Details> => () => ({ previewLines: lines });

const merge = (model: ResultModel, fragment: ResultFragment): ResultModel => ({
  output: fragment.output ?? model.output,
  emptyText: fragment.emptyText ?? model.emptyText,
  previewLines: fragment.previewLines ?? model.previewLines,
});

export const compose = <Input, Details>(
  ...parts: ReadonlyArray<ResultPart<Input, Details>>
) => (source: ResultSource<Input, Details>): ResultModel => {
  let model: ResultModel = {
    output: undefined,
    emptyText: undefined,
    previewLines: 5,
  };
  for (const part of parts) {
    const fragment = part(source);
    if (fragment !== undefined) model = merge(model, fragment);
  }
  return model;
};

class ShellResult extends Container {
  private footer: ReturnType<typeof ShellFooter.render> | undefined;

  update(
    model: ResultModel,
    footerModel: FooterModel,
    theme: Theme,
    expanded: boolean,
    isError: boolean,
  ): void {
    this.clear();
    const renderedOutput = model.output?.trimEnd() ?? "";
    if (renderedOutput.length === 0) {
      if (model.emptyText !== undefined) {
        this.addChild(
          new Text(`\n${theme.fg("dim", model.emptyText)}`, 0, 0),
        );
      }
    } else if (expanded || isError) {
      const lines: Array<string> = [];
      for (const line of renderedOutput.split("\n")) {
        lines.push(theme.fg("toolOutput", line || " "));
      }
      this.addChild(new Text(`\n${lines.join("\n")}`, 0, 0));
    } else {
      const lines: Array<string> = [];
      for (const line of renderedOutput.split("\n")) {
        lines.push(theme.fg("toolOutput", line || " "));
      }
      const styled = lines.join("\n");
      this.addChild({
        render: (width) => {
          const current = truncateToVisualLines(
            styled,
            model.previewLines,
            width,
          );
          const output: Array<string> = [""];
          if (current.skippedCount > 0) {
            output.push(
              theme.fg(
                "muted",
                `… ${current.skippedCount} earlier lines · `,
              ) + keyHint("app.tools.expand", "to expand"),
            );
          }
          for (const line of current.visualLines) output.push(line);
          return output;
        },
        invalidate() {},
      });
    }

    if (footerModel.segments.length > 0) {
      this.footer = ShellFooter.render(footerModel, theme, this.footer);
      this.addChild(new Spacer(1));
      this.addChild(this.footer);
    }
    this.invalidate();
  }
}

export const render = (
  model: ResultModel,
  footer: FooterModel,
  theme: Theme,
  previous: unknown,
  expanded: boolean,
  isError: boolean,
) => {
  const component =
    previous instanceof ShellResult ? previous : new ShellResult();
  component.update(model, footer, theme, expanded, isError);
  return component;
};
