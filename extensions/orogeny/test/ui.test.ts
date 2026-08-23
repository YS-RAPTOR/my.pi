import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView, Text, visibleWidth } from "@earendil-works/pi-tui";
import { Schema } from "effect";
import { Config } from "#o/config";
import { Code, CodeTheme, type CodeUiTheme, Outline, type OutlineTheme } from "#o/ui";

test("defaults syntax rendering to the transparent TokyoNight Moon code theme", () => {
  const config = Schema.decodeUnknownSync(Config.schema)({});
  assert.equal(config.syntax.theme.name, "tokyonight-moon");
  assert.equal("background" in config.syntax.theme, false);
  assert.equal(
    Object.values(config.syntax.theme.captures).some((style) => "background" in style),
    false,
  );
});

test("converts the configured capture theme for the native resolver", () => {
  const theme = CodeTheme.native(CodeTheme.tokyoNightMoon);
  const styles = new Map(theme.styles.map(({ name, ...style }) => [name, style]));

  assert.equal(theme.foreground, 0xc8d3f5);
  assert.deepEqual(styles.get("variable.parameter"), { foreground: 0xffc777 });
  assert.deepEqual(styles.get("tag.delimiter.tsx"), { foreground: 0x6582c3 });
  assert.deepEqual(styles.get("markup.emphasis"), { italic: true });
  assert.deepEqual(styles.get("none"), {});
});

test("fills the outline after a Text edge label instead of retaining its padding", () => {
  const theme: OutlineTheme = {
    fg: (_color, text) => text,
  };
  const top = new Outline({
    theme,
    phase: "running",
    top: new Text("PUSH · current", 0, 0),
    center: new Text("const answer = 42;", 0, 0),
  }).render(60)[0]!;

  assert.equal(visibleWidth(top), 60);
  assert.match(top, /^╭─ PUSH · current ─+╮$/);
});

test("keeps transcript scrolling detached while streamed code grows", () => {
  const theme: CodeUiTheme & OutlineTheme = {
    fg: (_color, text) => text,
    getColorMode: () => "truecolor",
  };
  const config = Schema.decodeUnknownSync(Config.schema)({});
  let source = Array.from({ length: 30 }, (_, index) => `const value_${index} = ${index};`).join(
    "\n",
  );
  const code = new Code(theme, config.syntax.theme, { source, expanded: true });
  const outline = new Outline({ theme, phase: "streaming", center: code });
  const scroll = new ScrollView(outline, { follow: "end" });
  const layout = () => scroll.updateLayout(scroll.render(80).length, 10, () => {});

  layout();
  scroll.scrollBy(-5);
  const detachedTop = scroll.scrollTop;
  for (let index = 0; index < 10; index++) {
    source += `\nconst appended_${index} = true;`;
    code.update(theme, { source, expanded: true });
    outline.invalidate();
    layout();
  }

  assert.equal(scroll.isFollowingEnd, false);
  assert.equal(scroll.scrollTop, detachedTop);
});

test("renders source control characters as inert text", () => {
  const theme: CodeUiTheme = {
    fg: (_color, text) => text,
    getColorMode: () => "truecolor",
  };
  const config = Schema.decodeUnknownSync(Config.schema)({});
  const rendered = new Code(theme, config.syntax.theme, {
    source: 'const value = "\u001b[31mred\u001b[0m";',
    expanded: true,
  }).render(80)[0]!;

  assert.equal(rendered.includes("\u001b[31m"), false);
  assert.equal(rendered.includes("\\x1b[31mred\\x1b[0m"), true);
});

test("renders packed native styles without adding a background", () => {
  const theme = new CodeTheme.Renderer(CodeTheme.tokyoNightMoon, "truecolor");
  const styled = theme.paint(0x03ffc777, "value");
  const fallback = theme.paint(undefined, "plain");

  assert.equal(
    styled,
    "\x1b[38;2;255;199;119m\x1b[1m\x1b[3mvalue\x1b[23m\x1b[22m\x1b[39m",
  );
  assert.equal(fallback, "\x1b[38;2;200;211;245mplain\x1b[39m");
  assert.equal(styled.includes("\x1b[48;"), false);
});
