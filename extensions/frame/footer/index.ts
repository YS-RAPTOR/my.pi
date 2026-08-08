import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { cacheComponent } from "./component/cache.ts";
import { contextComponent } from "./component/context.ts";
import { costComponent } from "./component/cost.ts";
import { cwdComponent } from "./component/cwd.ts";
import { modelComponent } from "./component/model.ts";
import { Runway } from "./component/runway/index.ts";
import { renderStatuses } from "./component/statuses.ts";
import { tokensComponent } from "./component/tokens.ts";
import type { FooterVariant } from "./component/types.ts";

type EntryUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
};

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate: number | undefined;
};

type RowItem = {
  key: string;
  side: "left" | "right";
  variants: readonly FooterVariant[];
};

type Degradation = {
  key: string;
  through: string;
};

function addUsage(totals: UsageTotals, usage: EntryUsage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

function collectUsage(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    latestCacheHitRate: undefined,
  };
  for (const entry of ctx.sessionManager.getEntries()) {
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
}

function subscriptionBacked(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  if (model.provider === "kimi-coding") return true;
  const oauth = ctx.modelRegistry.getProvider(model.provider)?.auth.oauth;
  return (
    ctx.modelRegistry.isUsingOAuth(model) && oauth?.isSubscription === true
  );
}

function align(left: string, right: string, width: number): string {
  if (!left) {
    return `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${right}`;
  }
  if (!right) return left;
  const padding = " ".repeat(
    Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
  );
  return `${left}${padding}${right}`;
}

function renderRow(
  items: readonly RowItem[],
  width: number,
  degradations: readonly Degradation[],
  shrinkOrder: readonly string[],
): string {
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
}

export class FrameFooter implements Component {
  private readonly unsubscribeBranch: () => void;

  constructor(
    private readonly getContext: () => ExtensionContext,
    private readonly theme: Theme,
    private readonly footerData: ReadonlyFooterDataProvider,
    private readonly runway: Runway,
    requestRender: () => void,
  ) {
    this.unsubscribeBranch = footerData.onBranchChange(requestRender);
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribeBranch();
  }

  render(width: number): string[] {
    const ctx = this.getContext();
    const usage = collectUsage(ctx);
    const context = ctx.getContextUsage();
    const cwd = cwdComponent(
      {
        cwd: ctx.sessionManager.getCwd(),
        home: process.env.HOME ?? process.env.USERPROFILE,
        branch: this.footerData.getGitBranch(),
        sessionName: ctx.sessionManager.getSessionName(),
      },
      this.theme,
    );
    const model = modelComponent(
      {
        id: ctx.model?.id,
        reasoning: ctx.model?.reasoning ?? false,
        thinkingLevel: ctx.thinkingLevel,
      },
      this.theme,
    )[0]!;
    const bottomItems: RowItem[] = [
      {
        key: "tokens",
        side: "left",
        variants: tokensComponent(
          {
            input: usage.input,
            output: usage.output,
          },
          this.theme,
        ),
      },
      {
        key: "cache",
        side: "left",
        variants: cacheComponent(
          {
            read: usage.cacheRead,
            write: usage.cacheWrite,
            hitRate: usage.latestCacheHitRate,
          },
          this.theme,
        ),
      },
      {
        key: "cost",
        side: "left",
        variants: costComponent(
          {
            total: usage.cost,
            subscription: subscriptionBacked(ctx),
          },
          this.theme,
        ),
      },
      {
        key: "context",
        side: "left",
        variants: contextComponent(
          {
            percent: context?.percent ?? null,
            contextWindow:
              context?.contextWindow ?? ctx.model?.contextWindow ?? 0,
          },
          this.theme,
        ),
      },
      {
        key: "runway",
        side: "right",
        variants: this.runway.variants(this.theme),
      },
    ];
    const top = renderRow(
      [
        { key: "cwd", side: "left", variants: cwd },
        { key: "model", side: "right", variants: [model] },
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
    const statuses = renderStatuses(
      this.footerData.getExtensionStatuses(),
      width,
      this.theme,
    );
    return [top, ...(bottom ? [bottom] : []), ...(statuses ? [statuses] : [])];
  }
}
