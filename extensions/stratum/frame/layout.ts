import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  HStack,
  ScrollView,
  VStack,
} from "@earendil-works/pi-tui";
import type { FrameSlots } from "./probe.ts";
import { SIDEBAR_BREAKPOINT, SIDEBAR_WIDTH } from "./sidebar/index.ts";

type RootOptions = Readonly<{
  sidebar?: Component;
}>;

class SidebarScrollView extends ScrollView {
  override scrollBy(lines: number): number {
    super.scrollBy(lines);
    return 0;
  }
}

export const createRoot = (
  slots: FrameSlots,
  theme: Theme,
  options: RootOptions = {},
): Component => {
  const transcript = new ScrollView(slots.document, {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "auto",
    scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
  });
  const dock = new VStack([
    { component: slots.pendingMessages, shrink: 1, minSize: 0 },
    { component: slots.status, shrink: 1, minSize: 0 },
    { component: slots.widgetsAbove, shrink: 1, minSize: 0 },
    { component: slots.editor, shrink: 1, minSize: 3 },
    { component: slots.widgetsBelow, shrink: 1, minSize: 0 },
    { component: slots.footer, shrink: 1, minSize: 1 },
  ]);

  const main = new VStack([
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

  if (!options.sidebar) return main;

  // ScrollView containment only stops ancestor chaining; Pi still sends any
  // leftover delta to the primary transcript. Report the wheel input as fully
  // consumed after giving the sidebar a chance to scroll.
  const sidebar = new SidebarScrollView(options.sidebar);

  return new HStack([
    {
      component: main,
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
    },
    {
      component: sidebar,
      basis: SIDEBAR_WIDTH,
      grow: 0,
      shrink: 0,
      minSize: SIDEBAR_WIDTH,
      maxSize: SIDEBAR_WIDTH,
      visible: ({ width }) => width >= SIDEBAR_BREAKPOINT,
    },
  ]);
};
