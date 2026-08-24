import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Image as TuiImage,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { statusColor, type StatusPhase } from "./status.ts";

class OutputImage implements Component {
  private readonly theme: Theme;
  private readonly phase: StatusPhase;
  private readonly annotation: string;
  private readonly image: TuiImage;

  constructor(
    theme: Theme,
    phase: StatusPhase,
    annotation: string,
    data: string,
    mimeType: string,
  ) {
    this.theme = theme;
    this.phase = phase;
    this.annotation = annotation;
    this.image = new TuiImage(
      data,
      mimeType,
      { fallbackColor: (text) => theme.fg("accent", text) },
      { maxWidthCells: 48, maxHeightCells: 12 },
    );
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const color = statusColor(this.phase);
    const content = truncateToWidth(this.annotation.trim(), Math.max(1, width - 6), "…");
    const label = ` ${content} `;
    const divider =
      this.theme.fg(color, "├─") +
      label +
      this.theme.fg(color, `${"─".repeat(Math.max(0, width - visibleWidth(label) - 3))}┤`);
    const image = this.image
      .render(Math.max(1, width - 8))
      .map((line) => (line === "" ? "" : `    ${line}`));
    return [divider, "", ...image, ""];
  }

  invalidate(): void {
    this.image.invalidate();
  }
}

// Pi currently appends tool-result images after self-rendered components. Keep
// this available until self-shell renderers can suppress that default image.
export const makeOutputImage = (options: {
  readonly theme: Theme;
  readonly phase: StatusPhase;
  readonly annotation: string;
  readonly data: string;
  readonly mimeType: string;
}): Component =>
  new OutputImage(options.theme, options.phase, options.annotation, options.data, options.mimeType);
