import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default (pi: ExtensionAPI): void => {
  pi.registerFlag("orogeny", {
    description: "Enable the Orogeny notebook runtime",
    type: "boolean",
    default: false,
  });
};
