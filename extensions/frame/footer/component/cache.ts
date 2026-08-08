import type { FooterComponent, FooterVariant } from "./types.ts";
import { fixedVariant, hiddenVariant } from "./types.ts";
import { formatTokens } from "./tokens.ts";

export type CacheData = {
  read: number;
  write: number;
  hitRate: number | undefined;
};

export const cacheComponent: FooterComponent<CacheData> = (
  data,
  theme,
): FooterVariant[] => {
  const parts: string[] = [];
  if (data.read) parts.push(`R${formatTokens(data.read)}`);
  if (data.write) parts.push(`W${formatTokens(data.write)}`);
  if ((data.read || data.write) && data.hitRate !== undefined) {
    parts.push(`CH${data.hitRate.toFixed(1)}%`);
  }
  return parts.length
    ? [fixedVariant("full", parts.join(" "), theme), hiddenVariant]
    : [hiddenVariant];
};
