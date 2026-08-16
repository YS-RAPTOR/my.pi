import type {
  ExtensionContext,
  ExtensionUIContext,
  ProjectTrustContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, pipe } from "effect";

type MethodKey = {
  [Key in keyof ExtensionUIContext]-?: ExtensionUIContext[Key] extends (
    ...args: never[]
  ) => infer _Result
    ? Key
    : never;
}[keyof ExtensionUIContext];

type EffectMethod<Method> = Method extends (
  ...args: infer Arguments
) => infer Result
  ? (
      ...args: Arguments
    ) => [Result] extends [PromiseLike<infer Value>]
      ? Effect.Effect<Value, Cause.UnknownError>
      : Effect.Effect<Result>
  : never;

type Methods = {
  readonly [Key in MethodKey]: EffectMethod<ExtensionUIContext[Key]>;
};

type WidgetContent = string[] | Parameters<ExtensionUIContext["setWidget"]>[1];

export type Interface = Omit<Methods, "setWidget"> &
  Readonly<{
    available: Effect.Effect<boolean>;
    theme: Effect.Effect<ExtensionUIContext["theme"]>;
    setWidget: (
      key: string,
      content: WidgetContent,
      options?: Parameters<ExtensionUIContext["setWidget"]>[2],
    ) => Effect.Effect<void>;
  }>;

export type ProjectTrust = Readonly<{
  available: Effect.Effect<boolean>;
  select: EffectMethod<ProjectTrustContext["ui"]["select"]>;
  confirm: EffectMethod<ProjectTrustContext["ui"]["confirm"]>;
  input: EffectMethod<ProjectTrustContext["ui"]["input"]>;
  notify: EffectMethod<ProjectTrustContext["ui"]["notify"]>;
}>;

const syncAction =
  <Arguments extends ReadonlyArray<unknown>, Value>(
    name: string,
    action: (...args: Arguments) => Value,
  ): ((...args: Arguments) => Effect.Effect<Value>) =>
  (...args) =>
    pipe(
      Effect.sync(() => action(...args)),
      Effect.withSpan(name),
    );

const asyncAction =
  <Arguments extends ReadonlyArray<unknown>, Value>(
    name: string,
    action: (...args: Arguments) => PromiseLike<Value>,
  ): ((...args: Arguments) => Effect.Effect<Value, Cause.UnknownError>) =>
  (...args) =>
    pipe(
      Effect.tryPromise(() => Promise.resolve(action(...args))),
      Effect.withSpan(name),
    );

export const from = (context: ExtensionContext): Interface => {
  const ui = context.ui;
  return {
    available: pipe(
      Effect.sync(() => context.hasUI),
      Effect.withSpan("Pi.Host.UI.available"),
    ),
    theme: pipe(
      Effect.sync(() => ui.theme),
      Effect.withSpan("Pi.Host.UI.theme"),
    ),
    select: asyncAction("Pi.Host.UI.select", ui.select.bind(ui)),
    confirm: asyncAction("Pi.Host.UI.confirm", ui.confirm.bind(ui)),
    input: asyncAction("Pi.Host.UI.input", ui.input.bind(ui)),
    notify: syncAction("Pi.Host.UI.notify", ui.notify.bind(ui)),
    onTerminalInput: syncAction(
      "Pi.Host.UI.onTerminalInput",
      ui.onTerminalInput.bind(ui),
    ),
    setStatus: syncAction("Pi.Host.UI.setStatus", ui.setStatus.bind(ui)),
    setWorkingMessage: syncAction(
      "Pi.Host.UI.setWorkingMessage",
      ui.setWorkingMessage.bind(ui),
    ),
    setWorkingVisible: syncAction(
      "Pi.Host.UI.setWorkingVisible",
      ui.setWorkingVisible.bind(ui),
    ),
    setWorkingIndicator: syncAction(
      "Pi.Host.UI.setWorkingIndicator",
      ui.setWorkingIndicator.bind(ui),
    ),
    setHiddenThinkingLabel: syncAction(
      "Pi.Host.UI.setHiddenThinkingLabel",
      ui.setHiddenThinkingLabel.bind(ui),
    ),
    setWidget: (key, content, options) =>
      pipe(
        Effect.sync(() => {
          if (Array.isArray(content)) ui.setWidget(key, content, options);
          else ui.setWidget(key, content, options);
        }),
        Effect.withSpan("Pi.Host.UI.setWidget"),
      ),
    setFooter: syncAction("Pi.Host.UI.setFooter", ui.setFooter.bind(ui)),
    setHeader: syncAction("Pi.Host.UI.setHeader", ui.setHeader.bind(ui)),
    setTitle: syncAction("Pi.Host.UI.setTitle", ui.setTitle.bind(ui)),
    custom: asyncAction("Pi.Host.UI.custom", ui.custom.bind(ui)),
    pasteToEditor: syncAction(
      "Pi.Host.UI.pasteToEditor",
      ui.pasteToEditor.bind(ui),
    ),
    setEditorText: syncAction(
      "Pi.Host.UI.setEditorText",
      ui.setEditorText.bind(ui),
    ),
    getEditorText: syncAction(
      "Pi.Host.UI.getEditorText",
      ui.getEditorText.bind(ui),
    ),
    editor: asyncAction("Pi.Host.UI.editor", ui.editor.bind(ui)),
    addAutocompleteProvider: syncAction(
      "Pi.Host.UI.addAutocompleteProvider",
      ui.addAutocompleteProvider.bind(ui),
    ),
    setEditorComponent: syncAction(
      "Pi.Host.UI.setEditorComponent",
      ui.setEditorComponent.bind(ui),
    ),
    getEditorComponent: syncAction(
      "Pi.Host.UI.getEditorComponent",
      ui.getEditorComponent.bind(ui),
    ),
    getAllThemes: syncAction(
      "Pi.Host.UI.getAllThemes",
      ui.getAllThemes.bind(ui),
    ),
    getTheme: syncAction("Pi.Host.UI.getTheme", ui.getTheme.bind(ui)),
    setTheme: syncAction("Pi.Host.UI.setTheme", ui.setTheme.bind(ui)),
    getToolsExpanded: syncAction(
      "Pi.Host.UI.getToolsExpanded",
      ui.getToolsExpanded.bind(ui),
    ),
    setToolsExpanded: syncAction(
      "Pi.Host.UI.setToolsExpanded",
      ui.setToolsExpanded.bind(ui),
    ),
  };
};

export const fromProjectTrust = (
  context: ProjectTrustContext,
): ProjectTrust => ({
  available: pipe(
    Effect.sync(() => context.hasUI),
    Effect.withSpan("Pi.Host.UI.ProjectTrust.available"),
  ),
  select: Effect.fn("Pi.Host.UI.ProjectTrust.select")((...args) =>
    Effect.tryPromise(() => context.ui.select(...args)),
  ),
  confirm: Effect.fn("Pi.Host.UI.ProjectTrust.confirm")((...args) =>
    Effect.tryPromise(() => context.ui.confirm(...args)),
  ),
  input: Effect.fn("Pi.Host.UI.ProjectTrust.input")((...args) =>
    Effect.tryPromise(() => context.ui.input(...args)),
  ),
  notify: Effect.fn("Pi.Host.UI.ProjectTrust.notify")((...args) =>
    Effect.sync(() => context.ui.notify(...args)),
  ),
});
