import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Syntax } from "#o/syntax";
import { CodeTheme } from "./code-theme.ts";
import { SyntaxCode } from "./syntax-code.ts";

export type OutputBlock =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "code"; language: string; text: string }>
  | Readonly<{ type: "image"; data: string; mimeType: string }>;

const COLLAPSED_LINES = 6;

export class OutputView implements Component {
  private readonly syntax: Syntax.Interface;
  private readonly codeTheme: CodeTheme.Value;
  private readonly codes = new Map<number, { language: string; component: SyntaxCode }>();
  private container = new Container();
  private expanded = false;
  private theme: Theme;

  constructor(syntax: Syntax.Interface, codeTheme: CodeTheme.Value, theme: Theme) {
    this.syntax = syntax;
    this.codeTheme = codeTheme;
    this.theme = theme;
  }

  update(options: {
    readonly theme: Theme;
    readonly output: ReadonlyArray<OutputBlock>;
    readonly expanded: boolean;
    readonly invalidate: () => void;
  }) {
    this.theme = options.theme;
    this.expanded = options.expanded;
    this.container = new Container();
    const retained = new Set<number>();

    for (const [index, output] of options.output.entries()) {
      if (output.type === "image") continue;
      if (output.type === "text") {
        const text = output.text.trimEnd();
        if (text !== "") this.container.addChild(new Text(options.theme.fg("text", text), 0, 0));
        continue;
      }

      const current = this.codes.get(index);
      const code =
        current?.language === output.language
          ? current.component
          : new SyntaxCode(this.syntax, output.language, this.codeTheme, options.theme);
      this.codes.set(index, { language: output.language, component: code });
      retained.add(index);
      this.container.addChild(
        code.update({
          theme: options.theme,
          source: output.text,
          expanded: true,
          sealed: true,
          invalidate: options.invalidate,
        }),
      );
    }

    for (const index of this.codes.keys()) if (!retained.has(index)) this.codes.delete(index);
    return this;
  }

  render(width: number): string[] {
    const lines = this.container.render(width);
    if (this.expanded || lines.length <= COLLAPSED_LINES) return lines;
    return [
      truncateToWidth(
        this.theme.fg("muted", `… ${lines.length - COLLAPSED_LINES} earlier lines`),
        width,
        "…",
      ),
      ...lines.slice(-COLLAPSED_LINES),
    ];
  }

  invalidate(): void {
    this.container.invalidate();
  }
}
