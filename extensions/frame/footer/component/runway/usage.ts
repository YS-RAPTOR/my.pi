import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type JsonObject = Record<string, unknown>;

export type UsageWindow = {
  usedPercent: number;
  resetAt?: number;
};

export type UsageReport = {
  primary?: UsageWindow;
  weekly: UsageWindow;
};

export class UsageUnavailableError extends Error {}

export function isCodexContext(ctx: ExtensionContext | undefined): boolean {
  return ctx?.model?.provider === CODEX_PROVIDER;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageUnavailableError(`${label} was unavailable.`);
  }
  return value as JsonObject;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : undefined;
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value, "quota window");
  const usedPercent = number(input.used_percent);
  const reset = number(input.reset_at);
  if (usedPercent === undefined) return undefined;
  const resetAt =
    reset && reset > 0
      ? reset < 10_000_000_000
        ? reset * 1_000
        : reset
      : undefined;
  return resetAt === undefined ? { usedPercent } : { usedPercent, resetAt };
}

export function normalizeUsage(payload: unknown): UsageReport {
  const rateLimit = object(
    object(payload, "Codex usage response").rate_limit,
    "Codex rate limit",
  );
  const primary = normalizeWindow(rateLimit.primary_window);
  const secondary = normalizeWindow(rateLimit.secondary_window);
  if (primary && secondary) return { primary, weekly: secondary };
  const weekly = secondary ?? primary;
  if (!weekly) {
    throw new UsageUnavailableError("Codex quota windows were unavailable.");
  }
  return { weekly };
}

export async function queryUsage(
  ctx: ExtensionContext,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<UsageReport> {
  const model = ctx.model;
  if (!model || model.provider !== CODEX_PROVIDER) {
    throw new UsageUnavailableError("Codex subscription auth was unavailable.");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new UsageUnavailableError(
      auth.ok ? "Codex subscription auth was unavailable." : auth.error,
    );
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value !== null) headers.set(name, value);
  }
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${auth.apiKey}`);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", "codex-runway");

  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const response = await fetch(USAGE_URL, { headers, signal });
  if (response.status === 401 || response.status === 403) {
    throw new UsageUnavailableError(
      "Codex subscription quota was unavailable.",
    );
  }
  if (!response.ok) {
    throw new Error(`Codex usage request failed (${response.status}).`);
  }
  return normalizeUsage(await response.json());
}
