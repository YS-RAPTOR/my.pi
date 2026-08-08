import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Runway } from "./footer/component/runway/index.ts";
import { FrameFooter } from "./footer/index.ts";
import { createStockEquivalentRoot } from "./layout.ts";
import { probeFrameLayout } from "./probe.ts";

export default function frame(pi: ExtensionAPI): void {
  let warningShown = false;
  let currentContext: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  const runway = new Runway();

  const updateContext = (ctx: ExtensionContext) => {
    currentContext = ctx;
    runway.updateContext(ctx);
    requestRender?.();
  };

  pi.on("session_start", (_event, ctx) => {
    updateContext(ctx);
    if (ctx.mode !== "tui" || requestRender) return;

    const result = probeFrameLayout(ctx);
    if (!result || result.kind === "inactive") return;

    if (result.kind === "invalid") {
      if (!warningShown) {
        warningShown = true;
        ctx.ui.notify(
          `Frame left Pi's layout unchanged: ${result.reason}.`,
          "warning",
        );
      }
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      runway.enable(requestRender);
      return new FrameFooter(
        () => currentContext ?? ctx,
        theme,
        footerData,
        runway,
        requestRender,
      );
    });
    result.tui.setLayoutRoot(createStockEquivalentRoot(result.slots, ctx));
  });

  pi.on("session_tree", (_event, ctx) => updateContext(ctx));
  pi.on("model_select", (_event, ctx) => updateContext(ctx));
  pi.on("turn_end", (_event, ctx) => updateContext(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    currentContext = ctx;
    runway.disable();
    ctx.ui.setFooter(undefined);
    requestRender = undefined;
    currentContext = undefined;
  });
}
