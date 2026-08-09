import type {
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  HStack,
  Text,
  VStack,
} from "@earendil-works/pi-tui";
import type { Entry as HeartbeatEntry } from "../../features/heartbeat/types.ts";
import { modelFromEntry as heartbeatModelFromEntry } from "../../features/heartbeat/tools/get.ts";
import { detailsFromEntry as heartbeatDetailsFromEntry } from "../../features/heartbeat/tools/shared.ts";
import type { ResourceSummary } from "../../features/shell/types.ts";
import { detailsFromSummary } from "../../features/shell/tools/inspect.ts";
import { modelFromDetails } from "../../features/shell/tools/list.ts";
import {
  ShellResource,
  ShellResourceList,
} from "../../features/shell/tools/rendering/index.ts";
import { Section, SECTION_HEIGHT } from "./section.ts";

export const SIDEBAR_WIDTH = 42;
export const SIDEBAR_BREAKPOINT = 75;
export const SIDEBAR_PADDING_LEFT = 0;
const HEARTBEAT_SECTION_HEIGHT = 9;

type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
type State = {
  thinkingLevel: ThinkingLevel;
  heartbeatActive: boolean;
};

class Divider implements Component {
  private readonly theme: Theme;
  private readonly getHeight: () => number;
  private readonly state: State;

  constructor(theme: Theme, getHeight: () => number, state: State) {
    this.theme = theme;
    this.getHeight = getHeight;
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): Array<string> {
    const height = this.getHeight();
    if (!Number.isFinite(height) || height <= 0) return [];

    const safeWidth = Math.max(1, Math.floor(width));
    const line = `${this.theme.getThinkingBorderColor(this.state.thinkingLevel)("│")}${" ".repeat(safeWidth - 1)}`;
    return Array.from({ length: Math.floor(height) }, () => line);
  }
}

export class Sidebar extends HStack {
  private readonly theme: Theme;
  private readonly state: State;
  private readonly activeShells: Section;
  private readonly heartbeatHost: Container;
  private readonly heartbeatResource: ShellResource.Component;
  private readonly listHost: Container;
  private readonly resourceList: ShellResourceList.Component;
  private heartbeat: HeartbeatEntry | null = null;
  private resources: ReadonlyArray<ResourceSummary> = [];

  constructor(
    theme: Theme,
    getHeight: () => number,
    thinkingLevel: ExtensionContext["thinkingLevel"],
  ) {
    const state: State = {
      thinkingLevel: thinkingLevel ?? "off",
      heartbeatActive: false,
    };
    const heartbeatHost = new Container();
    const heartbeatResource = new ShellResource.Component();
    const heartbeatSection = new Section(
      "Heartbeat",
      heartbeatHost,
      theme,
      HEARTBEAT_SECTION_HEIGHT,
    );
    const listHost = new Container();
    const resourceList = new ShellResourceList.Component();
    const activeShells = new Section("Active shells", listHost, theme);
    const sections = new VStack(
      [
        {
          component: heartbeatSection,
          basis: HEARTBEAT_SECTION_HEIGHT,
          grow: 0,
          shrink: 1,
          minSize: 3,
          maxSize: HEARTBEAT_SECTION_HEIGHT,
          visible: () => state.heartbeatActive,
        },
        {
          component: activeShells,
          basis: SECTION_HEIGHT,
          grow: 0,
          shrink: 1,
          minSize: 3,
          maxSize: SECTION_HEIGHT,
        },
      ],
      { gap: 1 },
    );

    super(
      [
        {
          component: new Divider(theme, getHeight, state),
          basis: 1,
          grow: 0,
          shrink: 0,
          minSize: 1,
          maxSize: 1,
        },
        { component: sections, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      ],
      { gap: SIDEBAR_PADDING_LEFT },
    );

    this.theme = theme;
    this.state = state;
    this.activeShells = activeShells;
    this.heartbeatHost = heartbeatHost;
    this.heartbeatResource = heartbeatResource;
    this.listHost = listHost;
    this.resourceList = resourceList;
    this.rebuild();
  }

  setThinkingLevel(level: ExtensionContext["thinkingLevel"]): void {
    this.state.thinkingLevel = level ?? "off";
  }

  updateHeartbeat(entry: HeartbeatEntry | null): void {
    this.heartbeat = entry;
    this.state.heartbeatActive = entry !== null;
    this.rebuildHeartbeat();
    super.invalidate();
  }

  updateShells(resources: ReadonlyArray<ResourceSummary>): void {
    this.resources = resources;
    this.rebuildShells();
    super.invalidate();
  }

  override invalidate(): void {
    this.rebuild();
    super.invalidate();
  }

  private rebuild(): void {
    this.rebuildHeartbeat();
    this.rebuildShells();
  }

  private rebuildHeartbeat(): void {
    this.heartbeatHost.clear();
    if (this.heartbeat === null) return;
    this.heartbeatResource.update(
      heartbeatModelFromEntry(
        heartbeatDetailsFromEntry(this.heartbeat),
        true,
      ),
      this.theme,
    );
    this.heartbeatHost.addChild(this.heartbeatResource);
  }

  private rebuildShells(): void {
    const count = this.resources.length;
    this.activeShells.setTitle(
      `Active shells${count > 0 ? ` · ${count}` : ""}`,
    );
    this.listHost.clear();
    if (count === 0) {
      this.listHost.addChild(
        new Text(this.theme.fg("dim", "No active shells."), 0, 1),
      );
      return;
    }

    this.resourceList.update(
      this.resources.map((summary) =>
        modelFromDetails(detailsFromSummary(summary))
      ),
      this.theme,
    );
    this.listHost.addChild(this.resourceList);
  }
}
