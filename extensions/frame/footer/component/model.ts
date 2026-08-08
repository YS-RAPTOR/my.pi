import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterComponent, FooterVariant } from "./types.ts";

export type ModelData = {
  id: string | undefined;
  reasoning: boolean;
  thinkingLevel: string | undefined;
};

export const modelComponent: FooterComponent<ModelData> = (
  data,
  theme: Theme,
): FooterVariant[] => {
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
