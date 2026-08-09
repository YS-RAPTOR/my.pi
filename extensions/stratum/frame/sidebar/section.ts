import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  ScrollView,
  Spacer,
  truncateToWidth,
  visibleWidth,
  VStack,
} from "@earendil-works/pi-tui";

export const SECTION_HEIGHT = 16;
const SECTION_BODY_HEIGHT = SECTION_HEIGHT - 1;
const SECTION_PADDING_X = 1;

const backgroundLine = (
  line: string,
  width: number,
  theme: Theme,
): string => {
  const clipped = truncateToWidth(line, width, "");
  return theme.bg(
    "customMessageBg",
    `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`,
  );
};

class Header implements Component {
  private readonly theme: Theme;
  private title: string;

  constructor(title: string, theme: Theme) {
    this.title = title;
    this.theme = theme;
  }

  setTitle(title: string): void {
    this.title = title;
  }

  invalidate(): void {}

  render(width: number): Array<string> {
    const safeWidth = Math.max(1, Math.floor(width));
    const title = ` ${this.theme.fg("accent", this.theme.bold(this.title))}`;
    return [truncateToWidth(title, safeWidth, "")];
  }
}

class BackgroundContent implements Component {
  private readonly content: Component;
  private readonly theme: Theme;

  constructor(content: Component, theme: Theme) {
    this.content = content;
    this.theme = theme;
  }

  invalidate(): void {
    this.content.invalidate();
  }

  render(width: number): Array<string> {
    const safeWidth = Math.max(1, Math.floor(width));
    const contentWidth = Math.max(1, safeWidth - SECTION_PADDING_X * 2);
    const lines = this.content
      .render(contentWidth)
      .map((line) => `${" ".repeat(SECTION_PADDING_X)}${line}`);
    while (lines.length < SECTION_BODY_HEIGHT) lines.push("");
    return lines.map((line) => backgroundLine(line, safeWidth, this.theme));
  }
}

export class Section extends VStack {
  private readonly header: Header;

  constructor(title: string, content: Component, theme: Theme) {
    const header = new Header(title, theme);
    const scrollContent = new VStack([content, new Spacer(1)]);
    const body = new ScrollView(new BackgroundContent(scrollContent, theme), {
      overscroll: "contain",
      scrollbar: "auto",
      scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
    });
    super([
      { component: header, basis: 1, grow: 0, shrink: 0, minSize: 1 },
      {
        component: body,
        basis: 0,
        grow: 1,
        shrink: 1,
        minSize: 0,
      },
    ]);
    this.header = header;
  }

  setTitle(title: string): void {
    this.header.setTitle(title);
  }
}
