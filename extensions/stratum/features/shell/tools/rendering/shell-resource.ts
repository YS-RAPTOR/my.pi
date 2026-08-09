import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component as TuiComponent,
  Container,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import * as ShellFooter from "./shell-footer.ts";
import type {
  FooterModel,
  MetadataRow,
  Mode,
  ResultSource,
} from "./types.ts";

export type Model = Readonly<{
  mode: Mode | undefined;
  command: string | undefined;
  metadata: ReadonlyArray<MetadataRow>;
  footer: FooterModel;
  footerSpacing: number;
  truncateCommand: boolean;
}>;

type Fragment = Readonly<{
  mode?: Mode;
  command?: string;
  metadata?: ReadonlyArray<MetadataRow>;
  footer?: FooterModel;
  footerSpacing?: number;
  truncateCommand?: boolean;
}>;

type Part<Input, Details> = (
  source: ResultSource<Input, Details>,
) => Fragment | undefined;

type Value<Input, Details, Output> = (
  source: ResultSource<Input, Details>,
) => Output | undefined;

export const mode = <Input, Details>(
  extract: Value<Input, Details, Mode>,
): Part<Input, Details> => (source) => {
  const value = extract(source);
  return value === undefined ? undefined : { mode: value };
};

export const command = <Input, Details>(
  extract: Value<Input, Details, string>,
): Part<Input, Details> => (source) => {
  const value = extract(source);
  return value === undefined ? undefined : { command: value };
};

export const truncateCommand = <Input, Details>(): Part<Input, Details> =>
  () => ({ truncateCommand: true });

export const metadata = <Input, Details>(
  label: string,
  extract: Value<Input, Details, string | number>,
): Part<Input, Details> => (source) => {
  const value = extract(source);
  return value === undefined
    ? undefined
    : { metadata: [{ label, value: String(value) }] };
};

export const footer = <Input, Details>(
  extract: (source: ResultSource<Input, Details>) => FooterModel,
  spacing = 1,
): Part<Input, Details> => (source) => ({
  footer: extract(source),
  footerSpacing: spacing,
});

export const compose = <Input, Details>(
  ...parts: ReadonlyArray<Part<Input, Details>>
) => (source: ResultSource<Input, Details>): Model => {
  let selectedMode: Mode | undefined;
  let selectedCommand: string | undefined;
  let selectedFooter: FooterModel = { segments: [] };
  let selectedFooterSpacing = 1;
  let shouldTruncateCommand = false;
  const rows: Array<MetadataRow> = [];

  for (const part of parts) {
    const fragment = part(source);
    if (fragment === undefined) continue;
    if (fragment.mode !== undefined) selectedMode = fragment.mode;
    if (fragment.command !== undefined) selectedCommand = fragment.command;
    if (fragment.footer !== undefined) selectedFooter = fragment.footer;
    if (fragment.footerSpacing !== undefined) {
      selectedFooterSpacing = fragment.footerSpacing;
    }
    if (fragment.truncateCommand !== undefined) {
      shouldTruncateCommand = fragment.truncateCommand;
    }
    for (const row of fragment.metadata ?? []) rows.push(row);
  }

  return {
    mode: selectedMode,
    command: selectedCommand,
    metadata: rows,
    footer: selectedFooter,
    footerSpacing: selectedFooterSpacing,
    truncateCommand: shouldTruncateCommand,
  };
};

class SingleLineCommand implements TuiComponent {
  private readonly command: string;
  private readonly theme: Theme;

  constructor(command: string, theme: Theme) {
    this.command = command;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): Array<string> {
    const safeWidth = Math.max(1, Math.floor(width));
    if (visibleWidth(this.command) <= safeWidth) {
      return [this.theme.fg("accent", this.command)];
    }
    const ellipsis = ".".repeat(Math.min(3, safeWidth));
    const truncated = truncateToWidth(
      this.command,
      safeWidth - ellipsis.length,
      "",
    );
    const reset = "\x1b[0m";
    const instruction = `${
      truncated.endsWith(reset) ? truncated.slice(0, -reset.length) : truncated
    }${ellipsis}`;
    return [this.theme.fg("accent", instruction)];
  }
}

export class Component extends Container {
  private footerComponent: ReturnType<typeof ShellFooter.render> | undefined;

  update(model: Model, theme: Theme): void {
    this.clear();
    if (model.mode !== undefined) {
      this.addChild(
        new Text(
          theme.fg("success", `[ ${model.mode.toUpperCase()} ]`),
          0,
          0,
        ),
      );
    }

    const metadata = model.metadata.map(
      ({ label, value }) =>
        `${theme.fg("dim", label)} ${theme.fg("muted", value)}`,
    );
    if (model.command !== undefined && model.truncateCommand) {
      if (model.mode === undefined) this.addChild(new Spacer(1));
      this.addChild(new SingleLineCommand(model.command, theme));
      if (metadata.length > 0) {
        this.addChild(new Text(metadata.join("\n"), 0, 0));
      }
    } else {
      const lines: Array<string> = [];
      if (model.command !== undefined) {
        if (model.mode === undefined) lines.push("");
        lines.push(theme.fg("accent", model.command));
      }
      lines.push(...metadata);
      if (lines.length > 0) {
        this.addChild(new Text(lines.join("\n"), 0, 0));
      }
    }

    if (model.footer.segments.length > 0) {
      this.footerComponent = ShellFooter.render(
        model.footer,
        theme,
        this.footerComponent,
      );
      if (model.footerSpacing > 0) {
        this.addChild(new Spacer(model.footerSpacing));
      }
      this.addChild(this.footerComponent);
    }
    this.invalidate();
  }
}

export const render = (
  model: Model,
  theme: Theme,
  previous: unknown,
) => {
  const component = previous instanceof Component ? previous : new Component();
  component.update(model, theme);
  return component;
};
