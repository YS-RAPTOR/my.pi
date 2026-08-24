import { Buffer } from "node:buffer";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Frame, Highlight } from "#o/syntax";
import { CodeTheme } from "./code-theme.ts";

type SourceLine = {
  text: string;
  readonly startIndex: number;
  endIndex: number;
  rendered?: Readonly<{ width: number; value: string }> | undefined;
};

export type CodeUiTheme = Pick<Theme, "fg" | "getColorMode">;

export type CodeValue = Readonly<{
  source: string;
  expanded: boolean;
  frame?: Frame | undefined;
}>;

const COLLAPSED_LINES = 6;

const printable = (text: string) => {
  let output = "";
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) continue;

    output += text.slice(start, index);
    output +=
      code === 0x09 ? "\\t" : code === 0x0d ? "\\r" : `\\x${code.toString(16).padStart(2, "0")}`;
    start = index + 1;
  }

  return start === 0 ? text : output + text.slice(start);
};

export class Code implements Component {
  private theme: CodeUiTheme;
  private readonly codeTheme: CodeTheme.Renderer;
  private source = "";
  private sourceBytes = 0;
  private lines: Array<SourceLine> = [{ text: "", startIndex: 0, endIndex: 0 }];
  private highlights: Array<Highlight> = [];
  private expanded = false;
  private colorMode: CodeTheme.ColorMode;
  private cachedWidth: number | undefined;
  private cachedLines: Array<string> | undefined;

  constructor(theme: CodeUiTheme, codeTheme: CodeTheme.Value, value: CodeValue) {
    this.theme = theme;
    this.colorMode = theme.getColorMode();
    this.codeTheme = new CodeTheme.Renderer(codeTheme, this.colorMode);
    this.update(theme, value);
  }

  update(theme: CodeUiTheme, value: CodeValue): void {
    this.theme = theme;
    const colorMode = theme.getColorMode();
    if (colorMode !== this.colorMode) {
      this.colorMode = colorMode;
      this.codeTheme.setColorMode(colorMode);
      this.invalidate();
    }
    if (value.expanded !== this.expanded) {
      this.expanded = value.expanded;
      this.invalidateOutput();
    }

    if (!value.source.startsWith(this.source)) {
      this.source = "";
      this.sourceBytes = 0;
      this.lines = [{ text: "", startIndex: 0, endIndex: 0 }];
      this.highlights = [];
      this.invalidateOutput();
    }

    const addition = value.source.slice(this.source.length);
    if (addition !== "") this.append(addition);
    this.source = value.source;
    if (value.frame !== undefined) this.apply(value.frame);
  }

  private append(source: string): void {
    const parts = source.split("\n");
    const current = this.lines[this.lines.length - 1]!;
    const first = parts[0]!;
    current.text += first;
    current.endIndex += Buffer.byteLength(first);
    current.rendered = undefined;
    this.sourceBytes += Buffer.byteLength(first);

    for (let index = 1; index < parts.length; index++) {
      this.sourceBytes += 1;
      const text = parts[index]!;
      const startIndex = this.sourceBytes;
      this.sourceBytes += Buffer.byteLength(text);
      this.lines.push({ text, startIndex, endIndex: this.sourceBytes });
    }
    this.invalidateOutput();
  }

  private apply(frame: Frame): void {
    const startIndex = Math.max(0, Math.min(frame.startIndex, this.sourceBytes));
    const endIndex = Math.max(startIndex, Math.min(frame.endIndex, this.sourceBytes));
    if (startIndex === endIndex) return;

    let lower = 0;
    let upper = this.highlights.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (this.highlights[middle]!.endIndex <= startIndex) lower = middle + 1;
      else upper = middle;
    }
    const first = lower;

    upper = this.highlights.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (this.highlights[middle]!.startIndex < endIndex) lower = middle + 1;
      else upper = middle;
    }
    const last = lower;

    const replacement: Array<Highlight> = [];
    const left = this.highlights[first];
    if (left !== undefined && left.startIndex < startIndex)
      replacement.push({ ...left, endIndex: startIndex });

    for (const highlight of frame.highlights) {
      const clippedStart = Math.max(startIndex, highlight.startIndex);
      const clippedEnd = Math.min(endIndex, highlight.endIndex);
      if (clippedStart < clippedEnd)
        replacement.push({
          ...highlight,
          startIndex: clippedStart,
          endIndex: clippedEnd,
        });
    }

    const right = this.highlights[last - 1];
    if (right !== undefined && right.endIndex > endIndex)
      replacement.push({ ...right, startIndex: endIndex });

    this.highlights.splice(first, last - first, ...replacement);

    let index = Math.max(1, first);
    const limit = Math.min(this.highlights.length, first + replacement.length + 2);
    while (index < limit && index < this.highlights.length) {
      const previous = this.highlights[index - 1]!;
      const current = this.highlights[index]!;
      if (previous.style === current.style && previous.endIndex === current.startIndex) {
        this.highlights[index - 1] = {
          ...previous,
          endIndex: current.endIndex,
        };
        this.highlights.splice(index, 1);
      } else index++;
    }

    for (const line of this.lines) {
      if (line.startIndex >= endIndex) break;
      if (line.endIndex > startIndex) line.rendered = undefined;
    }
    this.invalidateOutput();
  }

  private renderLine(line: SourceLine, width: number, start: number): string {
    const bytes = Buffer.from(line.text);
    let output = "";
    let cursor = line.startIndex;
    let index = start;

    while (index < this.highlights.length) {
      const highlight = this.highlights[index]!;
      if (highlight.startIndex >= line.endIndex) break;
      if (highlight.endIndex <= cursor) {
        index++;
        continue;
      }

      const highlightStart = Math.max(cursor, line.startIndex, highlight.startIndex);
      const highlightEnd = Math.min(line.endIndex, highlight.endIndex);
      if (cursor < highlightStart)
        output += this.codeTheme.paint(
          undefined,
          printable(
            bytes.subarray(cursor - line.startIndex, highlightStart - line.startIndex).toString(),
          ),
        );
      if (highlightStart < highlightEnd)
        output += this.codeTheme.paint(
          highlight.style,
          printable(
            bytes
              .subarray(highlightStart - line.startIndex, highlightEnd - line.startIndex)
              .toString(),
          ),
        );
      cursor = Math.max(cursor, highlightEnd);
      if (highlight.endIndex <= line.endIndex) index++;
      else break;
    }

    if (cursor < line.endIndex)
      output += this.codeTheme.paint(
        undefined,
        printable(bytes.subarray(cursor - line.startIndex).toString()),
      );
    return truncateToWidth(output, width, "…");
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width && this.cachedLines !== undefined) return this.cachedLines;

    const collapsed = !this.expanded && this.lines.length > COLLAPSED_LINES + 1;
    const visible = collapsed ? this.lines.slice(-COLLAPSED_LINES) : this.lines;
    const rendered: Array<string> = [];

    if (collapsed)
      rendered.push(
        truncateToWidth(
          this.theme.fg("muted", `… ${this.lines.length - visible.length} earlier lines`),
          width,
          "…",
        ),
      );
    let highlight = 0;

    for (const line of visible) {
      while (
        highlight < this.highlights.length &&
        this.highlights[highlight]!.endIndex <= line.startIndex
      )
        highlight++;
      if (line.rendered?.width !== width)
        line.rendered = {
          width,
          value: this.renderLine(line, width, highlight),
        };
      rendered.push(line.rendered.value);
    }

    this.cachedWidth = width;
    this.cachedLines = rendered;
    return rendered;
  }

  invalidate(): void {
    for (const line of this.lines) line.rendered = undefined;
    this.invalidateOutput();
  }

  private invalidateOutput(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
