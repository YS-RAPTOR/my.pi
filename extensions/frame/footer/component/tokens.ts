import type { FooterComponent, FooterVariant } from "./types.ts";
import { fixedVariant, hiddenVariant } from "./types.ts";

export type TokensData = {
  input: number;
  output: number;
};

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export const tokensComponent: FooterComponent<TokensData> = (
  data,
  theme,
): FooterVariant[] => {
  const parts: string[] = [];
  if (data.input) parts.push(`↑${formatTokens(data.input)}`);
  if (data.output) parts.push(`↓${formatTokens(data.output)}`);
  return parts.length
    ? [fixedVariant("full", parts.join(" "), theme), hiddenVariant]
    : [hiddenVariant];
};
