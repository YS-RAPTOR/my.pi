import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, ScrollView, VStack } from "@earendil-works/pi-tui";
import type { FrameSlots } from "./validation.ts";

export function createStockEquivalentRoot(
  slots: FrameSlots,
  ctx: ExtensionContext,
): Component {
  const transcript = new ScrollView(slots.document, {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "auto",
    scrollbarStyle: (text) => ctx.ui.theme.bg("scrollbarThumb", text),
  });
  const dock = new VStack([
    { component: slots.pendingMessages, shrink: 1, minSize: 0 },
    { component: slots.status, shrink: 1, minSize: 0 },
    { component: slots.widgetsAbove, shrink: 1, minSize: 0 },
    { component: slots.editor, shrink: 1, minSize: 3 },
    { component: slots.widgetsBelow, shrink: 1, minSize: 0 },
    { component: slots.footer, shrink: 1, minSize: 1 },
  ]);

  return new VStack([
    {
      component: transcript,
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
    },
    {
      component: dock,
      basis: "auto",
      grow: 0,
      shrink: 1,
      minSize: 1,
    },
  ]);
}
