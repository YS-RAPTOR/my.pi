import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProjectTrustContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, pipe } from "effect";

type AsyncResult<Method> = Method extends (...args: never[]) => infer Result
  ? Effect.Effect<Awaited<Result>, Cause.UnknownError>
  : never;

type SyncResult<Method> = Method extends (...args: never[]) => infer Result
  ? Effect.Effect<Result>
  : never;

export type Global = Readonly<{
  appendEntry: <Data>(customType: string, data?: Data) => Effect.Effect<void>;
  setSessionName: (name: string) => Effect.Effect<void>;
  getSessionName: Effect.Effect<string | undefined>;
  setLabel: (entryId: string, label: string | undefined) => Effect.Effect<void>;
  getCommands: SyncResult<ExtensionAPI["getCommands"]>;
}>;

export type Callback = Readonly<{
  cwd: Effect.Effect<ExtensionContext["cwd"]>;
  mode: Effect.Effect<ExtensionContext["mode"]>;
  sessionManager: Effect.Effect<ExtensionContext["sessionManager"]>;
  isProjectTrusted: SyncResult<ExtensionContext["isProjectTrusted"]>;
  getContextUsage: SyncResult<ExtensionContext["getContextUsage"]>;
  compact: (
    ...args: Parameters<ExtensionContext["compact"]>
  ) => SyncResult<ExtensionContext["compact"]>;
}>;

export type Command = Readonly<{
  newSession: (
    ...args: Parameters<ExtensionCommandContext["newSession"]>
  ) => AsyncResult<ExtensionCommandContext["newSession"]>;
  fork: (
    ...args: Parameters<ExtensionCommandContext["fork"]>
  ) => AsyncResult<ExtensionCommandContext["fork"]>;
  navigateTree: (
    ...args: Parameters<ExtensionCommandContext["navigateTree"]>
  ) => AsyncResult<ExtensionCommandContext["navigateTree"]>;
  switchSession: (
    ...args: Parameters<ExtensionCommandContext["switchSession"]>
  ) => AsyncResult<ExtensionCommandContext["switchSession"]>;
  reload: AsyncResult<ExtensionCommandContext["reload"]>;
}>;

export type ProjectTrust = Readonly<{
  cwd: Effect.Effect<ProjectTrustContext["cwd"]>;
  mode: Effect.Effect<ProjectTrustContext["mode"]>;
}>;

const asyncAction = <Arguments extends unknown[], Value>(
  name: string,
  action: (...args: Arguments) => Promise<Value>,
): ((...args: Arguments) => Effect.Effect<Value, Cause.UnknownError>) =>
  Effect.fn(name)((...args) => Effect.tryPromise(() => action(...args)));

export const global = (pi: ExtensionAPI): Global => {
  const appendEntry: Global["appendEntry"] = Effect.fn(
    "Pi.Host.SessionView.appendEntry",
  )(function* <Data>(customType: string, data?: Data) {
    yield* Effect.sync(() => pi.appendEntry(customType, data));
  });

  const setSessionName: Global["setSessionName"] = Effect.fn(
    "Pi.Host.SessionView.setSessionName",
  )((name) => Effect.sync(() => pi.setSessionName(name)));

  const getSessionName: Global["getSessionName"] = pipe(
    Effect.sync(() => pi.getSessionName()),
    Effect.withSpan("Pi.Host.SessionView.getSessionName"),
  );

  const setLabel: Global["setLabel"] = Effect.fn(
    "Pi.Host.SessionView.setLabel",
  )((entryId, label) => Effect.sync(() => pi.setLabel(entryId, label)));

  const getCommands: Global["getCommands"] = pipe(
    Effect.sync(() => pi.getCommands()),
    Effect.withSpan("Pi.Host.SessionView.getCommands"),
  );

  return {
    appendEntry,
    setSessionName,
    getSessionName,
    setLabel,
    getCommands,
  };
};

export const callback = (context: ExtensionContext): Callback => ({
  cwd: pipe(
    Effect.sync(() => context.cwd),
    Effect.withSpan("Pi.Host.SessionView.cwd"),
  ),
  mode: pipe(
    Effect.sync(() => context.mode),
    Effect.withSpan("Pi.Host.SessionView.mode"),
  ),
  sessionManager: pipe(
    Effect.sync(() => context.sessionManager),
    Effect.withSpan("Pi.Host.SessionView.sessionManager"),
  ),
  isProjectTrusted: pipe(
    Effect.sync(() => context.isProjectTrusted()),
    Effect.withSpan("Pi.Host.SessionView.isProjectTrusted"),
  ),
  getContextUsage: pipe(
    Effect.sync(() => context.getContextUsage()),
    Effect.withSpan("Pi.Host.SessionView.getContextUsage"),
  ),
  compact: Effect.fn("Pi.Host.SessionView.compact")((...args) =>
    Effect.sync(() => context.compact(...args)),
  ),
});

export const command = (context: ExtensionCommandContext): Command => ({
  newSession: asyncAction(
    "Pi.Host.SessionView.newSession",
    context.newSession.bind(context),
  ),
  fork: asyncAction("Pi.Host.SessionView.fork", context.fork.bind(context)),
  navigateTree: asyncAction(
    "Pi.Host.SessionView.navigateTree",
    context.navigateTree.bind(context),
  ),
  switchSession: asyncAction(
    "Pi.Host.SessionView.switchSession",
    context.switchSession.bind(context),
  ),
  reload: pipe(
    Effect.tryPromise(() => context.reload()),
    Effect.withSpan("Pi.Host.SessionView.reload"),
  ),
});

export const projectTrust = (context: ProjectTrustContext): ProjectTrust => ({
  cwd: pipe(
    Effect.sync(() => context.cwd),
    Effect.withSpan("Pi.Host.SessionView.ProjectTrust.cwd"),
  ),
  mode: pipe(
    Effect.sync(() => context.mode),
    Effect.withSpan("Pi.Host.SessionView.ProjectTrust.mode"),
  ),
});
