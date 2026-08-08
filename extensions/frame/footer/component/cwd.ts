import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterComponent, FooterVariant } from "./types.ts";

export type CwdData = {
  cwd: string;
  home: string | undefined;
  branch: string | null;
  sessionName: string | undefined;
};

function displayCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const fromHome = relative(resolve(home), resolve(cwd));
  const insideHome =
    fromHome === "" ||
    (fromHome !== ".." &&
      !fromHome.startsWith(`..${sep}`) &&
      !isAbsolute(fromHome));
  if (!insideHome) return cwd;
  return fromHome ? `~${sep}${fromHome}` : "~";
}

function truncateStart(text: string, width: number): string {
  const currentWidth = visibleWidth(text);
  if (currentWidth <= width) return text;
  if (width <= 0) return "";
  if (width === 1) return "…";
  return `…${sliceByColumn(text, currentWidth - width + 1, width - 1)}`;
}

export function cwdVariantTexts(data: CwdData): string[] {
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
}

export const cwdComponent: FooterComponent<CwdData> = (
  data,
  theme: Theme,
): FooterVariant[] =>
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
