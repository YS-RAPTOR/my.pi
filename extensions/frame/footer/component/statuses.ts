import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

function sanitize(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function renderStatuses(
  statuses: ReadonlyMap<string, string>,
  width: number,
  theme: Theme,
): string | undefined {
  if (!statuses.size) return undefined;
  const text = [...statuses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, status]) => sanitize(status))
    .join(" ");
  return truncateToWidth(text, width, theme.fg("dim", "…"));
}
