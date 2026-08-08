import type {
  ExtensionContext,
  ExtensionUIContext,
  ProjectTrustContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, pipe } from "effect";

type MethodKey = {
  [Key in keyof ExtensionUIContext]-?: ExtensionUIContext[Key] extends (
    ...args: never[]
  ) => unknown
    ? Key
    : never;
}[keyof ExtensionUIContext];

type EffectMethod<Method> = Method extends (
  ...args: infer Arguments
) => infer Result
  ? (
      ...args: Arguments
    ) => Result extends PromiseLike<infer Value>
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

const action = <Key extends MethodKey>(
  ui: ExtensionUIContext,
  key: Key,
  asynchronous: boolean,
): Interface[Key] => {
  const invoke = (...args: unknown[]) => {
    if (asynchronous) {
      return Effect.tryPromise(() =>
        Promise.resolve(Reflect.apply(Reflect.get(ui, key), ui, args)),
      );
    }
    return Effect.sync(() => Reflect.apply(Reflect.get(ui, key), ui, args));
  };
  return Effect.fn(`Pi.Host.UI.${key}`)(invoke) as Interface[Key];
};

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
    select: action(ui, "select", true),
    confirm: action(ui, "confirm", true),
    input: action(ui, "input", true),
    notify: action(ui, "notify", false),
    onTerminalInput: action(ui, "onTerminalInput", false),
    setStatus: action(ui, "setStatus", false),
    setWorkingMessage: action(ui, "setWorkingMessage", false),
    setWorkingVisible: action(ui, "setWorkingVisible", false),
    setWorkingIndicator: action(ui, "setWorkingIndicator", false),
    setHiddenThinkingLabel: action(ui, "setHiddenThinkingLabel", false),
    setWidget: action(ui, "setWidget", false),
    setFooter: action(ui, "setFooter", false),
    setHeader: action(ui, "setHeader", false),
    setTitle: action(ui, "setTitle", false),
    custom: action(ui, "custom", true),
    pasteToEditor: action(ui, "pasteToEditor", false),
    setEditorText: action(ui, "setEditorText", false),
    getEditorText: action(ui, "getEditorText", false),
    editor: action(ui, "editor", true),
    addAutocompleteProvider: action(ui, "addAutocompleteProvider", false),
    setEditorComponent: action(ui, "setEditorComponent", false),
    getEditorComponent: action(ui, "getEditorComponent", false),
    getAllThemes: action(ui, "getAllThemes", false),
    getTheme: action(ui, "getTheme", false),
    setTheme: action(ui, "setTheme", false),
    getToolsExpanded: action(ui, "getToolsExpanded", false),
    setToolsExpanded: action(ui, "setToolsExpanded", false),
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
