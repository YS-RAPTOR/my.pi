import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isViewportTUI,
  type TUI,
  type ViewportTUI,
} from "@earendil-works/pi-tui";
import { type FrameSlots, validateFrameLayout } from "./validation.ts";

const PROBE_KEY = "frame:probe";

class ProbeComponent implements Component {
  invalidate(): void {}

  render(_width: number): string[] {
    return [];
  }
}

export type ProbeResult =
  | { kind: "inactive"; tui: TUI }
  | { kind: "invalid"; tui: ViewportTUI; reason: string }
  | { kind: "valid"; tui: ViewportTUI; slots: FrameSlots };

export function probeFrameLayout(
  ctx: ExtensionContext,
): ProbeResult | undefined {
  const widgetProbe = new ProbeComponent();
  let tui: TUI | undefined;

  ctx.ui.setWidget(PROBE_KEY, (candidate) => {
    tui = candidate;
    return widgetProbe;
  });

  try {
    if (!tui) return undefined;
    if (!isViewportTUI(tui) || tui.mode !== "fullscreen") {
      return { kind: "inactive", tui };
    }

    const result = validateFrameLayout(tui.children, widgetProbe);
    return result.valid
      ? { kind: "valid", tui, slots: result.slots }
      : { kind: "invalid", tui, reason: result.reason };
  } finally {
    ctx.ui.setWidget(PROBE_KEY, undefined);
  }
}
