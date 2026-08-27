import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

export type StatusPhase = "streaming" | "running" | "done" | "error";
export type StatusColor = "warning" | "accent" | "success" | "error";

export type StatusValue = Readonly<{
  readonly phase: StatusPhase;
  readonly text: string;
}>;

const appearances = {
  streaming: { marker: "…", color: "warning" },
  running: { marker: "›", color: "accent" },
  done: { marker: "✓", color: "success" },
  error: { marker: "×", color: "error" },
} as const satisfies Readonly<
  Record<StatusPhase, Readonly<{ marker: string; color: StatusColor }>>
>;

export const statusColor = (phase: StatusPhase): StatusColor => appearances[phase].color;

export class Status implements Component {
  private readonly theme: Theme;
  readonly value: StatusValue;

  constructor(theme: Theme, value: StatusValue) {
    this.theme = theme;
    this.value = value;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const appearance = appearances[this.value.phase];
    const line =
      this.theme.fg(appearance.color, appearance.marker) +
      ` ${this.theme.fg("text", this.value.text)}`;
    return [truncateToWidth(line, width, "…")];
  }

  invalidate(): void {}
}
