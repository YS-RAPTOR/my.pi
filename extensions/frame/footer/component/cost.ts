import type { FooterComponent, FooterVariant } from "./types.ts";
import { fixedVariant, hiddenVariant } from "./types.ts";

export type CostData = {
  total: number;
  subscription: boolean;
};

export const costComponent: FooterComponent<CostData> = (
  data,
  theme,
): FooterVariant[] =>
  data.total || data.subscription
    ? [
        fixedVariant(
          "full",
          `$${data.total.toFixed(3)}${data.subscription ? " (sub)" : ""}`,
          theme,
        ),
        hiddenVariant,
      ]
    : [hiddenVariant];
