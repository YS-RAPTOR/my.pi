import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export type FooterVariant = Readonly<{
  id: string;
  minWidth: number;
  preferredWidth: number;
  render: (width: number) => string;
}>;

const fixedVariant = (
  id: string,
  text: string,
  theme: Theme,
): FooterVariant => {
  const width = visibleWidth(text);
  return {
    id,
    minWidth: width,
    preferredWidth: width,
    render: () => theme.fg("dim", text),
  };
};

const hiddenVariant: FooterVariant = {
  id: "hidden",
  minWidth: 0,
  preferredWidth: 0,
  render: () => "",
};

const optional = (
  text: string | undefined,
  theme: Theme,
): ReadonlyArray<FooterVariant> =>
  text ? [fixedVariant("full", text, theme), hiddenVariant] : [hiddenVariant];

const formatTokens = (count: number): string => {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
};

export const tokens = (
  data: Readonly<{ input: number; output: number }>,
  theme: Theme,
): ReadonlyArray<FooterVariant> => {
  const parts: Array<string> = [];
  if (data.input) parts.push(`↑${formatTokens(data.input)}`);
  if (data.output) parts.push(`↓${formatTokens(data.output)}`);
  return optional(parts.length ? parts.join(" ") : undefined, theme);
};

export const cache = (
  data: Readonly<{
    read: number;
    write: number;
    hitRate: number | undefined;
  }>,
  theme: Theme,
): ReadonlyArray<FooterVariant> => {
  const parts: Array<string> = [];
  if (data.read) parts.push(`R${formatTokens(data.read)}`);
  if (data.write) parts.push(`W${formatTokens(data.write)}`);
  if ((data.read || data.write) && data.hitRate !== undefined) {
    parts.push(`CH${data.hitRate.toFixed(1)}%`);
  }
  return optional(parts.length ? parts.join(" ") : undefined, theme);
};

export const cost = (
  data: Readonly<{ total: number; subscription: boolean }>,
  theme: Theme,
): ReadonlyArray<FooterVariant> =>
  optional(
    data.total || data.subscription
      ? `$${data.total.toFixed(3)}${data.subscription ? " (sub)" : ""}`
      : undefined,
    theme,
  );

export const context = (
  data: Readonly<{
    percent: number | null;
    contextWindow: number;
    warningPercent: number;
    errorPercent: number;
  }>,
  theme: Theme,
): ReadonlyArray<FooterVariant> => {
  const text =
    data.percent === null
      ? `?/${formatTokens(data.contextWindow)}`
      : `${data.percent.toFixed(1)}%/${formatTokens(data.contextWindow)}`;
  const rendered =
    data.percent !== null && data.percent > data.errorPercent
      ? theme.fg("error", text)
      : data.percent !== null && data.percent > data.warningPercent
        ? theme.fg("warning", text)
        : theme.fg("dim", text);
  const width = visibleWidth(text);
  return [
    {
      id: "full",
      minWidth: width,
      preferredWidth: width,
      render: () => rendered,
    },
    hiddenVariant,
  ];
};

export const model = (
  data: Readonly<{
    id: string | undefined;
    reasoning: boolean;
    thinkingLevel: string | undefined;
  }>,
  theme: Theme,
): ReadonlyArray<FooterVariant> => {
  const id = data.id ?? "no-model";
  const thinkingLevel = data.thinkingLevel ?? "off";
  const text = data.reasoning
    ? `${id} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`
    : id;
  return [
    {
      id: "elastic",
      minWidth: 1,
      preferredWidth: visibleWidth(text),
      render: (width) =>
        truncateToWidth(theme.fg("dim", text), width, theme.fg("dim", "…")),
    },
  ];
};

type CwdData = Readonly<{
  cwd: string;
  home: string | undefined;
  branch: string | null;
  sessionName: string | undefined;
}>;

const displayCwd = (cwd: string, home: string | undefined): string => {
  if (!home) return cwd;
  const fromHome = relative(resolve(home), resolve(cwd));
  const insideHome =
    fromHome === "" ||
    (fromHome !== ".." &&
      !fromHome.startsWith(`..${sep}`) &&
      !isAbsolute(fromHome));
  if (!insideHome) return cwd;
  return fromHome ? `~${sep}${fromHome}` : "~";
};

const truncateStart = (text: string, width: number): string => {
  const currentWidth = visibleWidth(text);
  if (currentWidth <= width) return text;
  if (width <= 0) return "";
  if (width === 1) return "…";
  return `…${sliceByColumn(text, currentWidth - width + 1, width - 1)}`;
};

const cwdVariantTexts = (data: CwdData): Array<string> => {
  const path = displayCwd(data.cwd, data.home);
  const suffix = `${data.branch ? ` (${data.branch})` : ""}${data.sessionName ? ` • ${data.sessionName}` : ""}`;
  const parts = path.split(sep).filter((part) => part && part !== "~");
  const paths = [path];
  for (let index = 1; index < parts.length; index++) {
    paths.push(
      index === parts.length - 1
        ? parts[index]!
        : `…${sep}${parts.slice(index).join(sep)}`,
    );
  }
  return [...new Set(paths.map((candidate) => `${candidate}${suffix}`))];
};

export const cwd = (
  data: CwdData,
  theme: Theme,
): ReadonlyArray<FooterVariant> =>
  cwdVariantTexts(data).map((text, index, variants) => {
    const width = visibleWidth(text);
    const final = index === variants.length - 1;
    return {
      id: index === 0 ? "full" : final ? "last-folder" : `drop-${index}`,
      minWidth: final ? 1 : width,
      preferredWidth: width,
      render: (availableWidth) =>
        theme.fg("dim", truncateStart(text, availableWidth)),
    };
  });

const sanitizeStatus = (text: string): string =>
  text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();

export const statuses = (
  values: ReadonlyMap<string, string>,
  width: number,
  theme: Theme,
): string | undefined => {
  if (!values.size) return undefined;
  const text = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, status]) => sanitizeStatus(status))
    .join(" ");
  return truncateToWidth(text, width, theme.fg("dim", "…"));
};
