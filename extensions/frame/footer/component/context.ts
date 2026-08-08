import type { FooterComponent, FooterVariant } from "./types.ts";
import { hiddenVariant } from "./types.ts";
import { formatTokens } from "./tokens.ts";

export type ContextData = {
  percent: number | null;
  contextWindow: number;
};

export const contextComponent: FooterComponent<ContextData> = (
  data,
  theme,
): FooterVariant[] => {
  const text =
    data.percent === null
      ? `?/${formatTokens(data.contextWindow)}`
      : `${data.percent.toFixed(1)}%/${formatTokens(data.contextWindow)}`;
  const render =
    data.percent !== null && data.percent > 90
      ? theme.fg("error", text)
      : data.percent !== null && data.percent > 70
        ? theme.fg("warning", text)
        : theme.fg("dim", text);
  return [
    {
      id: "full",
      minWidth: text.length,
      preferredWidth: text.length,
      render: () => render,
    },
    hiddenVariant,
  ];
};
