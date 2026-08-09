import {
  type Component,
  isViewportTUI,
  type TUI,
  type ViewportTUI,
} from "@earendil-works/pi-tui";
import { Data, Effect, MutableRef, Predicate } from "effect";
import { Pi } from "#s/pi";

const probeKey = "frame:probe";

export type FrameSlots = Readonly<{
  document: Component;
  pendingMessages: Component;
  status: Component;
  widgetsAbove: Component;
  editor: Component;
  widgetsBelow: Component;
  footer: Component;
}>;

type ComponentContainer = Component & { children: Array<Component> };
type Validation = Data.TaggedEnum<{
  invalid: { reason: string };
  valid: { slots: FrameSlots };
}>;

const Validation = Data.taggedEnum<Validation>();

type Result = Data.TaggedEnum<{
  inactive: {};
  invalid: { tui: ViewportTUI; reason: string };
  valid: { tui: ViewportTUI; slots: FrameSlots };
}>;

const Result = Data.taggedEnum<Result>();

class ProbeComponent implements Component {
  invalidate(): void {}

  render(_width: number): Array<string> {
    return [];
  }
}

const isComponent = (value: unknown): value is Component => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Component>;
  return (
    typeof candidate.render === "function" &&
    typeof candidate.invalidate === "function"
  );
};

const container = (component: Component): ComponentContainer | undefined => {
  const children = (component as { children?: unknown }).children;
  return Array.isArray(children) && children.every(isComponent)
    ? (component as ComponentContainer)
    : undefined;
};

const validate = (
  mountedValues: ReadonlyArray<unknown>,
  widgetProbe: Component,
): Validation => {
  if (mountedValues.length !== 7) {
    return Validation.invalid({
      reason: `expected 7 mounted components, received ${mountedValues.length}`,
    });
  }
  if (!mountedValues.every(isComponent)) {
    return Validation.invalid({
      reason: "a mounted value does not implement the Component interface",
    });
  }

  const mounted = mountedValues as ReadonlyArray<Component>;
  if (new Set(mounted).size !== mounted.length) {
    return Validation.invalid({ reason: "mounted components are not unique" });
  }

  const containers = mounted.map(container);
  if (containers.some((candidate) => candidate === undefined)) {
    return Validation.invalid({
      reason: "each mounted root component must expose component children",
    });
  }

  const document = mounted[0]!;
  const pendingMessages = mounted[1]!;
  const status = mounted[2]!;
  const widgetsAbove = mounted[3]!;
  const editor = mounted[4]!;
  const widgetsBelow = mounted[5]!;
  const footer = mounted[6]!;
  const documentContainer = containers[0]!;
  const widgetsAboveContainer = containers[3]!;
  const editorContainer = containers[4]!;
  const footerContainer = containers[6]!;

  if (
    documentContainer.children.length !== 3 ||
    documentContainer.children.some((child) => container(child) === undefined)
  ) {
    return Validation.invalid({
      reason: "the first mounted component is not Pi's document container",
    });
  }
  if (!widgetsAboveContainer.children.includes(widgetProbe)) {
    return Validation.invalid({
      reason:
        "the fourth mounted component is not the above-editor widget container",
    });
  }
  if (editorContainer.children.length !== 1) {
    return Validation.invalid({
      reason:
        "the fifth mounted component is not Pi's single-child editor host",
    });
  }
  if (
    footerContainer.children.length !== 1 ||
    footerContainer.children[0]!.constructor.name !== "FooterComponent"
  ) {
    return Validation.invalid({
      reason: "the seventh mounted component is not Pi's built-in footer",
    });
  }

  return Validation.valid({
    slots: {
      document,
      pendingMessages,
      status,
      widgetsAbove,
      editor,
      widgetsBelow,
      footer,
    },
  });
};

export const probeFrameLayout = Effect.fn("Frame.probe")(function* (
  ui: Pi.Host.UI.Interface,
) {
  const widgetProbe = new ProbeComponent();
  const captured = MutableRef.make<TUI | undefined>(undefined);

  return yield* Effect.gen(function* () {
    yield* ui.setWidget(probeKey, (tui) => {
      captured.current = tui;
      return widgetProbe;
    });

    const tui = captured.current;
    if (!tui || !isViewportTUI(tui) || tui.mode !== "fullscreen") {
      return Result.inactive();
    }

    const result = validate(tui.children, widgetProbe);
    return Predicate.isTagged(result, "valid")
      ? Result.valid({ tui, slots: result.slots })
      : Result.invalid({ tui, reason: result.reason });
  }).pipe(Effect.ensuring(ui.setWidget(probeKey, undefined)));
});
