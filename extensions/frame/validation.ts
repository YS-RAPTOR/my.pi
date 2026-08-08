import type { Component } from "@earendil-works/pi-tui";

export type FrameSlots = {
  document: Component;
  pendingMessages: Component;
  status: Component;
  widgetsAbove: Component;
  editor: Component;
  widgetsBelow: Component;
  footer: Component;
};

export type FrameLayoutOutput =
  { valid: true; slots: FrameSlots } | { valid: false; reason: string };

type ComponentContainer = Component & { children: Component[] };

function isComponent(value: unknown): value is Component {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Component>;
  return (
    typeof candidate.render === "function" &&
    typeof candidate.invalidate === "function"
  );
}

function asContainer(component: Component): ComponentContainer | undefined {
  const children = (component as { children?: unknown }).children;
  return Array.isArray(children) && children.every(isComponent)
    ? (component as ComponentContainer)
    : undefined;
}

function invalid(reason: string): FrameLayoutOutput {
  return { valid: false, reason };
}

export function validateFrameLayout(
  mountedValues: readonly unknown[],
  widgetProbe: Component,
): FrameLayoutOutput {
  if (mountedValues.length !== 7) {
    return invalid(
      `expected 7 mounted components, received ${mountedValues.length}`,
    );
  }
  if (!mountedValues.every(isComponent)) {
    return invalid(
      "a mounted value does not implement the Component interface",
    );
  }

  const mounted = mountedValues as readonly Component[];
  if (new Set(mounted).size !== mounted.length) {
    return invalid("mounted components are not unique");
  }

  const containers = mounted.map(asContainer);
  if (containers.some((container) => container === undefined)) {
    return invalid(
      "each mounted root component must expose component children",
    );
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
    documentContainer.children.some((child) => asContainer(child) === undefined)
  ) {
    return invalid(
      "the first mounted component is not Pi's document container",
    );
  }
  if (!widgetsAboveContainer.children.includes(widgetProbe)) {
    return invalid(
      "the fourth mounted component is not the above-editor widget container",
    );
  }
  if (editorContainer.children.length !== 1) {
    return invalid(
      "the fifth mounted component is not Pi's single-child editor host",
    );
  }
  if (
    footerContainer.children.length !== 1 ||
    footerContainer.children[0]!.constructor.name !== "FooterComponent"
  ) {
    return invalid("the seventh mounted component is not Pi's built-in footer");
  }

  return {
    valid: true,
    slots: {
      document,
      pendingMessages,
      status,
      widgetsAbove,
      editor,
      widgetsBelow,
      footer,
    },
  };
}
