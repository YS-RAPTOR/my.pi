import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, pipe } from "effect";

type AsyncResult<Method> = Method extends (...args: never[]) => infer Result
  ? Effect.Effect<Awaited<Result>, Cause.UnknownError>
  : never;

type SyncResult<Method> = Method extends (...args: never[]) => infer Result
  ? Effect.Effect<Result>
  : never;

export type Global = Readonly<{
  sendMessage: (
    ...args: Parameters<ExtensionAPI["sendMessage"]>
  ) => SyncResult<ExtensionAPI["sendMessage"]>;
  sendUserMessage: (
    ...args: Parameters<ExtensionAPI["sendUserMessage"]>
  ) => SyncResult<ExtensionAPI["sendUserMessage"]>;
  exec: (...args: Parameters<ExtensionAPI["exec"]>) => AsyncResult<ExtensionAPI["exec"]>;
  getFlag: (...args: Parameters<ExtensionAPI["getFlag"]>) => SyncResult<ExtensionAPI["getFlag"]>;
  getActiveTools: SyncResult<ExtensionAPI["getActiveTools"]>;
  getAllTools: SyncResult<ExtensionAPI["getAllTools"]>;
  setActiveTools: (
    ...args: Parameters<ExtensionAPI["setActiveTools"]>
  ) => SyncResult<ExtensionAPI["setActiveTools"]>;
  setModel: (
    ...args: Parameters<ExtensionAPI["setModel"]>
  ) => AsyncResult<ExtensionAPI["setModel"]>;
  getThinkingLevel: SyncResult<ExtensionAPI["getThinkingLevel"]>;
  setThinkingLevel: (
    ...args: Parameters<ExtensionAPI["setThinkingLevel"]>
  ) => SyncResult<ExtensionAPI["setThinkingLevel"]>;
}>;

export type Callback = Readonly<{
  modelRegistry: Effect.Effect<ExtensionContext["modelRegistry"]>;
  model: Effect.Effect<ExtensionContext["model"]>;
  scopedModels: Effect.Effect<ExtensionContext["scopedModels"]>;
  thinkingLevel: Effect.Effect<ExtensionContext["thinkingLevel"]>;
  signal: Effect.Effect<ExtensionContext["signal"]>;
  isIdle: SyncResult<ExtensionContext["isIdle"]>;
  abort: SyncResult<ExtensionContext["abort"]>;
  hasPendingMessages: SyncResult<ExtensionContext["hasPendingMessages"]>;
  shutdown: SyncResult<ExtensionContext["shutdown"]>;
  getSystemPrompt: SyncResult<ExtensionContext["getSystemPrompt"]>;
}>;

export type Command = Readonly<{
  getSystemPromptOptions: SyncResult<ExtensionCommandContext["getSystemPromptOptions"]>;
  waitForIdle: AsyncResult<ExtensionCommandContext["waitForIdle"]>;
}>;

const asyncAction = <Arguments extends unknown[], Value>(
  name: string,
  action: (...args: Arguments) => Promise<Value>,
): ((...args: Arguments) => Effect.Effect<Value, Cause.UnknownError>) =>
  Effect.fn(name)((...args) => Effect.tryPromise(() => action(...args)));

export const global = (pi: ExtensionAPI): Global => {
  const sendMessage: Global["sendMessage"] = Effect.fn("Pi.Host.AgentState.sendMessage")(
    (...args) => Effect.sync(() => pi.sendMessage(...args)),
  );

  const sendUserMessage: Global["sendUserMessage"] = Effect.fn(
    "Pi.Host.AgentState.sendUserMessage",
  )((...args) => Effect.sync(() => pi.sendUserMessage(...args)));

  const exec: Global["exec"] = Effect.fn("Pi.Host.AgentState.exec")((command, args, options) =>
    Effect.tryPromise((signal) =>
      pi.exec(command, args, {
        ...options,
        signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
      }),
    ),
  );

  const getFlag: Global["getFlag"] = Effect.fn("Pi.Host.AgentState.getFlag")((...args) =>
    Effect.sync(() => pi.getFlag(...args)),
  );

  const getActiveTools: Global["getActiveTools"] = pipe(
    Effect.sync(() => pi.getActiveTools()),
    Effect.withSpan("Pi.Host.AgentState.getActiveTools"),
  );

  const getAllTools: Global["getAllTools"] = pipe(
    Effect.sync(() => pi.getAllTools()),
    Effect.withSpan("Pi.Host.AgentState.getAllTools"),
  );

  const setActiveTools: Global["setActiveTools"] = Effect.fn("Pi.Host.AgentState.setActiveTools")(
    (...args) => Effect.sync(() => pi.setActiveTools(...args)),
  );

  const setModel: Global["setModel"] = asyncAction(
    "Pi.Host.AgentState.setModel",
    pi.setModel.bind(pi),
  );

  const getThinkingLevel: Global["getThinkingLevel"] = pipe(
    Effect.sync(() => pi.getThinkingLevel()),
    Effect.withSpan("Pi.Host.AgentState.getThinkingLevel"),
  );

  const setThinkingLevel: Global["setThinkingLevel"] = Effect.fn(
    "Pi.Host.AgentState.setThinkingLevel",
  )((...args) => Effect.sync(() => pi.setThinkingLevel(...args)));

  return {
    sendMessage,
    sendUserMessage,
    exec,
    getFlag,
    getActiveTools,
    getAllTools,
    setActiveTools,
    setModel,
    getThinkingLevel,
    setThinkingLevel,
  };
};

export const callback = (context: ExtensionContext): Callback => ({
  modelRegistry: pipe(
    Effect.sync(() => context.modelRegistry),
    Effect.withSpan("Pi.Host.AgentState.modelRegistry"),
  ),
  model: pipe(
    Effect.sync(() => context.model),
    Effect.withSpan("Pi.Host.AgentState.model"),
  ),
  scopedModels: pipe(
    Effect.sync(() => context.scopedModels),
    Effect.withSpan("Pi.Host.AgentState.scopedModels"),
  ),
  thinkingLevel: pipe(
    Effect.sync(() => context.thinkingLevel),
    Effect.withSpan("Pi.Host.AgentState.thinkingLevel"),
  ),
  signal: pipe(
    Effect.sync(() => context.signal),
    Effect.withSpan("Pi.Host.AgentState.signal"),
  ),
  isIdle: pipe(
    Effect.sync(() => context.isIdle()),
    Effect.withSpan("Pi.Host.AgentState.isIdle"),
  ),
  abort: pipe(
    Effect.sync(() => context.abort()),
    Effect.withSpan("Pi.Host.AgentState.abort"),
  ),
  hasPendingMessages: pipe(
    Effect.sync(() => context.hasPendingMessages()),
    Effect.withSpan("Pi.Host.AgentState.hasPendingMessages"),
  ),
  shutdown: pipe(
    Effect.sync(() => context.shutdown()),
    Effect.withSpan("Pi.Host.AgentState.shutdown"),
  ),
  getSystemPrompt: pipe(
    Effect.sync(() => context.getSystemPrompt()),
    Effect.withSpan("Pi.Host.AgentState.getSystemPrompt"),
  ),
});

export const command = (context: ExtensionCommandContext): Command => ({
  getSystemPromptOptions: pipe(
    Effect.sync(() => context.getSystemPromptOptions()),
    Effect.withSpan("Pi.Host.AgentState.getSystemPromptOptions"),
  ),
  waitForIdle: pipe(
    Effect.tryPromise(() => context.waitForIdle()),
    Effect.withSpan("Pi.Host.AgentState.waitForIdle"),
  ),
});
