import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { UsageReport, UsageWindow } from "./usage.ts";

const RESET_BG = "\x1b[49m";
const GLYPHS = [
  "⠀",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
] as const;
const STYLES = {
  full: { steps: 50, groupSize: 10, brackets: true },
  compact: { steps: 20, groupSize: 0, brackets: false },
} as const;

export type RunwayMode = keyof typeof STYLES;

type Rgb = readonly [red: number, green: number, blue: number];
type Severity = { color: ThemeColor; tint: number };

function remaining(window: UsageWindow): number {
  return 100 - Math.min(100, Math.max(0, window.usedPercent));
}

function severity(value: number): Severity {
  if (value <= 0) return { color: "thinkingMax", tint: 0.38 };
  if (value <= 5) return { color: "thinkingXhigh", tint: 0.3 };
  if (value <= 15) return { color: "thinkingHigh", tint: 0.18 };
  if (value <= 50) return { color: "thinkingMedium", tint: 0.12 };
  return { color: "thinkingMinimal", tint: 0 };
}

function ansiRgb(ansi: string, channel: 38 | 48): Rgb | undefined {
  const match = ansi.match(
    new RegExp(`\\x1b\\[${channel};2;(\\d+);(\\d+);(\\d+)m`),
  );
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function rgbBackground([red, green, blue]: Rgb): string {
  return `\x1b[48;2;${red};${green};${blue}m`;
}

function runwayBackground(theme: Theme, weekly: UsageWindow): string {
  const state = severity(remaining(weekly));
  if (!state.tint) {
    return theme.bg("selectedBg", "").replace(RESET_BG, "");
  }
  const base = ansiRgb(theme.bg("toolSuccessBg", ""), 48);
  const tint = ansiRgb(theme.fg(state.color, ""), 38);
  if (!base || !tint) {
    return theme
      .fg(state.color, "")
      .replace("[38;", "[48;")
      .replace("\x1b[39m", "");
  }
  const blend = (index: number) =>
    Math.round(base[index]! + (tint[index]! - base[index]!) * state.tint);
  return rgbBackground([blend(0), blend(1), blend(2)]);
}

function steps(window: UsageWindow, count: number): number {
  const value = remaining(window);
  return value <= 0
    ? 0
    : Math.max(1, Math.min(count, Math.round(value / (100 / count))));
}

function masks(report: UsageReport, count: number): number[] {
  const weekly = steps(report.weekly, count);
  if (!report.primary) {
    return Array.from({ length: count }, (_, index) =>
      index < weekly ? 15 : 0,
    );
  }
  const primary = steps(report.primary, count);
  return Array.from(
    { length: count },
    (_, index) => (index < primary ? 3 : 0) | (index < weekly ? 12 : 0),
  );
}

function renderBar(
  values: number[],
  foreground: ThemeColor,
  background: string,
  theme: Theme,
  mode: RunwayMode,
): string {
  const { brackets, groupSize } = STYLES[mode];
  const paint = (text: string, color: ThemeColor) =>
    theme.fg(color, `${background}${text}${RESET_BG}`);
  const cells = values.map((mask) =>
    paint(GLYPHS[mask] ?? GLYPHS[0], foreground),
  );
  const groups = groupSize
    ? Array.from({ length: Math.ceil(cells.length / groupSize) }, (_, index) =>
        cells.slice(index * groupSize, (index + 1) * groupSize).join(""),
      )
    : [cells.join("")];
  const content = groups.join(paint("|", "thinkingOff"));
  return brackets
    ? `${theme.fg("muted", "[")}${content}${theme.fg("muted", "]")}`
    : content;
}

export function formatResetCountdown(resetAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((resetAt - now) / 1_000));
  if (seconds > 86_400) {
    const tenths = Math.max(10, Math.ceil(seconds / 8_640));
    return `${tenths % 10 ? (tenths / 10).toFixed(1) : tenths / 10}d`;
  }
  if (seconds >= 3_600) {
    const tenths = Math.max(10, Math.ceil(seconds / 360));
    return `${tenths % 10 ? (tenths / 10).toFixed(1) : tenths / 10}h`;
  }
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`;
}

function countdown(window: UsageWindow, theme: Theme, now: number): string {
  const text =
    window.resetAt === undefined
      ? "?"
      : formatResetCountdown(window.resetAt, now);
  return theme.fg(severity(remaining(window)).color, text);
}

export function renderReport(
  report: UsageReport,
  theme: Theme,
  mode: RunwayMode,
  now: number,
): string {
  const count = STYLES[mode].steps;
  const renderedBar = renderBar(
    masks(report, count),
    severity(remaining(report.primary ?? report.weekly)).color,
    runwayBackground(theme, report.weekly),
    theme,
    mode,
  );
  const weekly = countdown(report.weekly, theme, now);
  return report.primary
    ? `${countdown(report.primary, theme, now)}/${weekly} ${renderedBar}`
    : `${weekly} ${renderedBar}`;
}

export function renderLoading(
  theme: Theme,
  mode: RunwayMode,
  frame: number,
): string {
  const count = STYLES[mode].steps;
  const cycle = (count - 1) * 2;
  const offset = Math.abs(Math.trunc(frame)) % cycle;
  const primary = offset < count ? offset : cycle - offset;
  const values = Array<number>(count).fill(0);
  values[primary] = 3;
  values[count - primary - 1] = 12;
  const background = theme.bg("selectedBg", "").replace(RESET_BG, "");
  return `${theme.fg("muted", "…/…")} ${renderBar(values, "thinkingLow", background, theme, mode)}`;
}

function renderEmpty(
  theme: Theme,
  mode: RunwayMode,
  label: string,
  labelColor: ThemeColor,
  barColor: ThemeColor,
  weekly: UsageWindow,
): string {
  const values = Array(STYLES[mode].steps).fill(0);
  return `${theme.fg(labelColor, label)} ${renderBar(values, barColor, runwayBackground(theme, weekly), theme, mode)}`;
}

export function renderUnavailable(theme: Theme, mode: RunwayMode): string {
  return renderEmpty(theme, mode, "n/a", "muted", "thinkingOff", {
    usedPercent: 0,
  });
}

export function renderError(theme: Theme, mode: RunwayMode): string {
  return renderEmpty(theme, mode, "error", "error", "thinkingMax", {
    usedPercent: 100,
  });
}
