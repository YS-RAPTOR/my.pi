import { Effect, Layer, pipe } from "effect";
import { Config } from "#s/config";
import { Expansion } from "#s/features/better-skills/expansion";
import { Gating } from "#s/features/better-skills/gating";
import { Inline } from "#s/features/better-skills/inline";
import { Runtime } from "#s/features/better-skills/runtime";

const configuredLayer = (config: Config.Value["better-skills"]) => {
  const features = Layer.mergeAll(
    config.expansion ? Expansion.layer : Layer.empty,
    config.gating ? Gating.layer(config.inline) : Layer.empty,
    config.inline ? Inline.layer : Layer.empty,
  ).pipe(Layer.provide(Runtime.layer));

  return Layer.mergeAll(Runtime.layer, features);
};

export const layer = pipe(
  Effect.map(Config.Service, ({ "better-skills": config }) =>
    config.enabled ? configuredLayer(config) : Layer.empty,
  ),
  Layer.unwrap,
);

export { Expansion } from "#s/features/better-skills/expansion";
export { Gating } from "#s/features/better-skills/gating";
export { Inline } from "#s/features/better-skills/inline";
export { Runtime } from "#s/features/better-skills/runtime";
export * as BetterSkills from "./index.ts";
