import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Predicate, Schema, pipe } from "effect";

const codexProvider = "openai-codex";
const usageUrl = "https://chatgpt.com/backend-api/wham/usage";
const requestTimeoutMillis = 15_000;

const Numeric = Schema.Union([Schema.Finite, Schema.FiniteFromString]);
const UsageWindowPayload = Schema.Struct({
  used_percent: Numeric,
  reset_at: Schema.optionalKey(Schema.NullOr(Numeric)),
});
const UsagePayload = Schema.Struct({
  rate_limit: Schema.Struct({
    primary_window: Schema.optionalKey(Schema.NullOr(UsageWindowPayload)),
    secondary_window: Schema.optionalKey(Schema.NullOr(UsageWindowPayload)),
  }),
});
const decodeUsage = Schema.decodeUnknownEffect(UsagePayload);

type UsageWindowPayload = typeof UsageWindowPayload.Type;

export type Context = Readonly<{
  model: ExtensionContext["model"];
  modelRegistry: ExtensionContext["modelRegistry"];
}>;

export type UsageWindow = Readonly<{
  usedPercent: number;
  resetAt?: number;
}>;

export type UsageReport = Readonly<{
  primary?: UsageWindow;
  weekly: UsageWindow;
}>;

export class UsageUnavailable extends Data.TaggedError("UsageUnavailable")<{
  readonly message: string;
}> {}

export class UsageFailed extends Data.TaggedError("UsageFailed")<{
  readonly message: string;
}> {}

export const isCodexContext = (
  context: Context,
): context is Context & { model: NonNullable<Context["model"]> } =>
  context.model?.provider === codexProvider;

const normalizeWindow = (
  input: UsageWindowPayload | null | undefined,
): UsageWindow | undefined => {
  if (input === undefined || input === null) return undefined;
  const reset = input.reset_at;
  const resetAt =
    reset && reset > 0
      ? reset < 10_000_000_000
        ? reset * 1_000
        : reset
      : undefined;
  return resetAt === undefined
    ? { usedPercent: input.used_percent }
    : { usedPercent: input.used_percent, resetAt };
};

const failureMessage = (cause: unknown, fallback: string) =>
  Predicate.isError(cause) && cause.message ? cause.message : fallback;

export const queryUsage = Effect.fn("Frame.Footer.Runway.queryUsage")(
  function* (context: Context) {
    if (!isCodexContext(context)) {
      return yield* new UsageUnavailable({
        message: "Codex subscription auth was unavailable.",
      });
    }

    const auth = yield* Effect.tryPromise({
      try: () => context.modelRegistry.getApiKeyAndHeaders(context.model),
      catch: (cause) =>
        new UsageFailed({
          message: failureMessage(cause, "Unable to resolve Codex auth."),
        }),
    });
    if (!auth.ok || !auth.apiKey) {
      return yield* new UsageUnavailable({
        message: auth.ok
          ? "Codex subscription auth was unavailable."
          : auth.error,
      });
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(auth.headers ?? {})) {
      if (value !== null) headers.set(name, value);
    }
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${auth.apiKey}`);
    }
    if (!headers.has("user-agent")) headers.set("user-agent", "codex-runway");

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(usageUrl, {
          headers,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(requestTimeoutMillis),
          ]),
        }),
      catch: (cause) =>
        new UsageFailed({
          message: failureMessage(cause, "Codex usage request failed."),
        }),
    });
    if (response.status === 401 || response.status === 403) {
      return yield* new UsageUnavailable({
        message: "Codex subscription quota was unavailable.",
      });
    }
    if (!response.ok) {
      return yield* new UsageFailed({
        message: `Codex usage request failed (${response.status}).`,
      });
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        new UsageFailed({
          message: failureMessage(cause, "Codex usage response was invalid."),
        }),
    });
    const decoded = yield* pipe(
      decodeUsage(payload),
      Effect.mapError(
        () =>
          new UsageUnavailable({
            message: "Codex quota windows were unavailable.",
          }),
      ),
    );
    const primary = normalizeWindow(decoded.rate_limit.primary_window);
    const secondary = normalizeWindow(decoded.rate_limit.secondary_window);
    if (primary && secondary) return { primary, weekly: secondary };
    const weekly = secondary ?? primary;
    if (!weekly) {
      return yield* new UsageUnavailable({
        message: "Codex quota windows were unavailable.",
      });
    }
    return { weekly };
  },
);
