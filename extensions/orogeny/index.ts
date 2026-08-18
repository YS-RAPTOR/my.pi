import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const Orogeny = (pi: ExtensionAPI): void => {
  pi.registerFlag("orogeny", {
    description: "Enable the Orogeny notebook runtime",
    type: "boolean",
    default: false,
  });
};

export default Orogeny;
