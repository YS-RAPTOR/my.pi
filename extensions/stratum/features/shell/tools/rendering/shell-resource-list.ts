import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import * as ShellResource from "./shell-resource.ts";

export class Component extends Container {
  update(models: ReadonlyArray<ShellResource.Model>, theme: Theme): void {
    this.clear();
    if (models.length > 0) this.addChild(new Spacer(1));
    for (let index = 0; index < models.length; index += 1) {
      if (index > 0) this.addChild(new Spacer(1));
      const model = models[index];
      if (model !== undefined) {
        this.addChild(ShellResource.render(model, theme, undefined));
      }
    }
    this.invalidate();
  }
}

export const render = (
  models: ReadonlyArray<ShellResource.Model>,
  theme: Theme,
  previous: unknown,
) => {
  const component = previous instanceof Component ? previous : new Component();
  component.update(models, theme);
  return component;
};
