import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type {
  CallFragment,
  CallModel,
  CallPart,
  CallSource,
  Mode,
} from "./types.ts";

type Value<Input, Output> = (source: CallSource<Input>) => Output | undefined;

export const name = <Input>(value: string): CallPart<Input> => () => ({
  name: value,
});

export const mode = <Input>(
  extract: Value<Input, Mode>,
): CallPart<Input> => (source) => {
  const value = extract(source);
  return value === undefined ? undefined : { mode: value };
};

export const primary = <Input>(
  extract: Value<Input, string>,
): CallPart<Input> => (source) => {
  const value = extract(source);
  return value === undefined ? undefined : { primary: value };
};

export const metadata = <Input>(
  label: string,
  extract: Value<Input, string | number>,
): CallPart<Input> => (source) => {
  const value = extract(source);
  return value === undefined
    ? undefined
    : { metadata: [{ label, value: String(value) }] };
};

const merge = (model: CallModel, fragment: CallFragment): CallModel => {
  const rows = Array.from(model.metadata);
  for (const row of fragment.metadata ?? []) rows.push(row);
  return {
    name: fragment.name ?? model.name,
    mode: fragment.mode ?? model.mode,
    primary: fragment.primary ?? model.primary,
    metadata: rows,
  };
};

export const compose = <Input>(...parts: ReadonlyArray<CallPart<Input>>) =>
  (source: CallSource<Input>): CallModel => {
    let model: CallModel = {
      name: "shell",
      mode: undefined,
      primary: undefined,
      metadata: [],
    };
    for (const part of parts) {
      const fragment = part(source);
      if (fragment !== undefined) model = merge(model, fragment);
    }
    return model;
  };

class ShellCall extends Container {
  update(model: CallModel, theme: Theme): void {
    this.clear();
    const badge =
      model.mode === undefined
        ? ""
        : ` ${theme.fg("success", `[ ${model.mode.toUpperCase()} ]`)}`;
    const body: Array<string> = [];
    if (model.primary !== undefined) {
      body.push(theme.fg("accent", theme.bold(model.primary)));
    }
    for (const { label, value } of model.metadata) {
      body.push(`${theme.fg("dim", label)} ${theme.fg("muted", value)}`);
    }
    const header = `${theme.fg("toolTitle", theme.bold(model.name))}${badge}`;
    const separator = model.primary === undefined ? "\n" : "\n\n";
    this.addChild(
      new Text(
        body.length === 0 ? header : `${header}${separator}${body.join("\n")}`,
        0,
        0,
      ),
    );
    this.invalidate();
  }
}

export const render = (
  model: CallModel,
  theme: Theme,
  previous: unknown,
) => {
  const component = previous instanceof ShellCall ? previous : new ShellCall();
  component.update(model, theme);
  return component;
};
