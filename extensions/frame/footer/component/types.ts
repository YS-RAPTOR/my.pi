import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export type FooterVariant = {
  id: string;
  minWidth: number;
  preferredWidth: number;
  render(width: number): string;
};

export type FooterComponent<T> = (
  data: T,
  theme: Theme,
) => readonly FooterVariant[];

export function fixedVariant(
  id: string,
  text: string,
  theme: Theme,
): FooterVariant {
  const width = visibleWidth(text);
  return {
    id,
    minWidth: width,
    preferredWidth: width,
    render: () => theme.fg("dim", text),
  };
}

export const hiddenVariant: FooterVariant = {
  id: "hidden",
  minWidth: 0,
  preferredWidth: 0,
  render: () => "",
};
