import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { statusColor, type StatusPhase } from "./status.ts";

export type OutlineEdge = Component;
export type OutlineTheme = Pick<Theme, "fg">;

export type OutlineOptions = Readonly<{
  readonly theme: OutlineTheme;
  readonly phase: StatusPhase;
  readonly top?: OutlineEdge;
  readonly center: Component;
  readonly footer?: Component;
  readonly bottom?: OutlineEdge;
}>;

const fit = (text: string, width: number) => (width <= 0 ? "" : truncateToWidth(text, width, "…"));

const pad = (text: string, width: number) => {
  const fitted = fit(text, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
};

export class Outline implements Component {
  private readonly options: OutlineOptions;
  private bodyWidth: number | undefined;
  private bodyPadding: number | undefined;
  private bodyLines: Array<Readonly<{ content: string; rendered: string }>> = [];

  constructor(options: OutlineOptions) {
    this.options = options;
  }

  private edgeContent(edge: OutlineEdge, width: number) {
    return fit((edge.render(width)[0] ?? "").trimEnd(), width);
  }

  private edge(
    edge: OutlineEdge | undefined,
    width: number,
    corners: readonly [left: string, right: string],
  ) {
    const color = statusColor(this.options.phase);
    const border = (text: string) => this.options.theme.fg(color, text);
    if (width <= 1) return border(corners[0]);
    if (width === 2) return border(`${corners[0]}${corners[1]}`);
    if (edge === undefined || width < 5)
      return border(`${corners[0]}${"─".repeat(width - 2)}${corners[1]}`);

    const content = this.edgeContent(edge, width - 5);
    const label = ` ${content} `;
    const remaining = Math.max(0, width - visibleWidth(label) - 3);
    return border(`${corners[0]}─`) + label + border(`${"─".repeat(remaining)}${corners[1]}`);
  }

  private bodyLine(content: string, width: number, padding: number) {
    const color = statusColor(this.options.phase);
    const border = (text: string) => this.options.theme.fg(color, text);
    if (width <= 1) return border("│");

    const innerWidth = width - 2;
    const contentWidth = Math.max(0, innerWidth - padding * 2);
    return (
      border("│") +
      " ".repeat(padding) +
      pad(content, contentWidth) +
      " ".repeat(padding) +
      border("│")
    );
  }

  render(width: number): string[] {
    if (width <= 0) return [];

    const innerWidth = Math.max(0, width - 2);
    const padding = Math.min(3, Math.max(0, Math.floor((innerWidth - 1) / 2)));
    const contentWidth = Math.max(0, innerWidth - padding * 2);
    const content = contentWidth === 0 ? [] : this.options.center.render(contentWidth);
    const footer = this.options.footer?.render(width) ?? [];
    const blank = this.bodyLine("", width, padding);

    if (this.bodyWidth !== width || this.bodyPadding !== padding) {
      this.bodyWidth = width;
      this.bodyPadding = padding;
      this.bodyLines = [];
    }
    const body = content.map((line, index) => {
      const cached = this.bodyLines[index];
      if (cached?.content === line) return cached.rendered;
      const rendered = this.bodyLine(line, width, padding);
      this.bodyLines[index] = { content: line, rendered };
      return rendered;
    });
    this.bodyLines.length = content.length;

    return [
      this.edge(this.options.top, width, ["╭", "╮"]),
      blank,
      ...body,
      blank,
      ...footer,
      this.edge(this.options.bottom, width, ["╰", "╯"]),
    ];
  }

  invalidate(): void {
    this.bodyWidth = undefined;
    this.bodyPadding = undefined;
    this.bodyLines = [];
    this.options.top?.invalidate();
    this.options.center.invalidate();
    this.options.footer?.invalidate();
    this.options.bottom?.invalidate();
  }
}
