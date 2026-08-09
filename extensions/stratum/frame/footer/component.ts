import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
  cache,
  context,
  cost,
  cwd,
  model,
  statuses,
  tokens,
  type FooterVariant,
} from "./parts.ts";
import type { Interface as Runway } from "./runway/index.ts";

export type View = Readonly<{
  sessionManager: ExtensionContext["sessionManager"];
  modelRegistry: ExtensionContext["modelRegistry"];
  model: ExtensionContext["model"];
  thinkingLevel: ExtensionContext["thinkingLevel"];
  contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
}>;

type EntryUsage = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}>;

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate: number | undefined;
};

type RowItem = Readonly<{
  key: string;
  side: "left" | "right";
  variants: ReadonlyArray<FooterVariant>;
}>;

type Degradation = Readonly<{
  key: string;
  through: string;
}>;

const item = (
  key: string,
  side: RowItem["side"],
  variants: ReadonlyArray<FooterVariant>,
): RowItem => ({ key, side, variants });

const addUsage = (totals: UsageTotals, usage: EntryUsage): void => {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
};

const collectUsage = (view: View): UsageTotals => {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    latestCacheHitRate: undefined,
  };
  for (const entry of view.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = entry.message.usage;
      addUsage(totals, usage);
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      totals.latestCacheHitRate =
        prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage
    ) {
      addUsage(totals, entry.message.usage);
    } else if (
      (entry.type === "compaction" || entry.type === "branch_summary") &&
      entry.usage
    ) {
      addUsage(totals, entry.usage);
    }
  }
  return totals;
};

const subscriptionBacked = (view: View): boolean => {
  const selected = view.model;
  if (!selected) return false;
  if (selected.provider === "kimi-coding") return true;
  const oauth = view.modelRegistry.getProvider(selected.provider)?.auth.oauth;
  return (
    view.modelRegistry.isUsingOAuth(selected) && oauth?.isSubscription === true
  );
};

const align = (left: string, right: string, width: number): string => {
  if (!left) {
    return `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${right}`;
  }
  if (!right) return left;
  const padding = " ".repeat(
    Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
  );
  return `${left}${padding}${right}`;
};

const renderRow = (
  items: ReadonlyArray<RowItem>,
  width: number,
  degradations: ReadonlyArray<Degradation>,
  shrinkOrder: ReadonlyArray<string>,
): string => {
  const selected = items
    .filter((item) => item.variants.length)
    .map((item) => ({
      item,
      index: 0,
      width: item.variants[0]!.preferredWidth,
    }));
  const active = () => selected.filter((entry) => entry.width > 0);
  const totalWidth = () => {
    const entries = active();
    const left = entries.filter((entry) => entry.item.side === "left").length;
    const right = entries.length - left;
    const gaps =
      Math.max(0, left - 1) + Math.max(0, right - 1) + (left && right ? 1 : 0);
    return entries.reduce((total, entry) => total + entry.width, gaps);
  };

  for (const { key, through } of degradations) {
    const entry = selected.find((candidate) => candidate.item.key === key);
    const target =
      entry?.item.variants.findIndex((variant) => variant.id === through) ?? -1;
    while (entry && totalWidth() > width && entry.index < target) {
      entry.index += 1;
      entry.width = entry.item.variants[entry.index]!.preferredWidth;
    }
  }
  for (const key of shrinkOrder) {
    const entry = selected.find((candidate) => candidate.item.key === key);
    if (!entry || totalWidth() <= width) continue;
    const variant = entry.item.variants[entry.index]!;
    entry.width -= Math.min(
      entry.width - variant.minWidth,
      totalWidth() - width,
    );
  }

  const renderSide = (side: RowItem["side"]) =>
    active()
      .filter((entry) => entry.item.side === side)
      .map((entry) => entry.item.variants[entry.index]!.render(entry.width))
      .filter(Boolean)
      .join(" ");
  return align(renderSide("left"), renderSide("right"), width);
};

export class FrameFooter implements Component {
  private readonly getView: () => View;
  private readonly theme: Theme;
  private readonly footerData: ReadonlyFooterDataProvider;
  private readonly runway: Runway;
  private readonly unsubscribeBranch: () => void;

  constructor(
    getView: () => View,
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
    runway: Runway,
    requestRender: () => void,
  ) {
    this.getView = getView;
    this.theme = theme;
    this.footerData = footerData;
    this.runway = runway;
    this.unsubscribeBranch = footerData.onBranchChange(requestRender);
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribeBranch();
  }

  render(width: number): Array<string> {
    const view = this.getView();
    const usage = collectUsage(view);
    const contextUsage = view.contextUsage;
    const cwdVariants = cwd(
      {
        cwd: view.sessionManager.getCwd(),
        home: process.env.HOME ?? process.env.USERPROFILE,
        branch: this.footerData.getGitBranch(),
        sessionName: view.sessionManager.getSessionName(),
      },
      this.theme,
    );
    const modelVariant = model(
      {
        id: view.model?.id,
        reasoning: view.model?.reasoning ?? false,
        thinkingLevel: view.thinkingLevel,
      },
      this.theme,
    )[0]!;
    const bottomItems = [
      item(
        "tokens",
        "left",
        tokens({ input: usage.input, output: usage.output }, this.theme),
      ),
      item(
        "cache",
        "left",
        cache(
          {
            read: usage.cacheRead,
            write: usage.cacheWrite,
            hitRate: usage.latestCacheHitRate,
          },
          this.theme,
        ),
      ),
      item(
        "cost",
        "left",
        cost(
          {
            total: usage.cost,
            subscription: subscriptionBacked(view),
          },
          this.theme,
        ),
      ),
      item(
        "context",
        "left",
        context(
          {
            percent: contextUsage?.percent ?? null,
            contextWindow:
              contextUsage?.contextWindow ?? view.model?.contextWindow ?? 0,
          },
          this.theme,
        ),
      ),
      item("runway", "right", this.runway.variants(this.theme)),
    ];
    const top = renderRow(
      [
        item("cwd", "left", cwdVariants),
        item("model", "right", [modelVariant]),
      ],
      width,
      [{ key: "cwd", through: "last-folder" }],
      ["model", "cwd"],
    );
    const bottom = renderRow(
      bottomItems,
      width,
      [
        { key: "runway", through: "compact" },
        { key: "tokens", through: "hidden" },
        { key: "cache", through: "hidden" },
        { key: "cost", through: "hidden" },
        { key: "runway", through: "elastic" },
      ],
      ["runway"],
    );
    const statusLine = statuses(
      this.footerData.getExtensionStatuses(),
      width,
      this.theme,
    );
    return [
      top,
      ...(bottom ? [bottom] : []),
      ...(statusLine ? [statusLine] : []),
    ];
  }
}
