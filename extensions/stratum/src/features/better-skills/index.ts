import { Effect, Layer, pipe } from "effect";
import { Config } from "#s/config";
import { Expansion } from "#s/features/better-skills/expansion";
import { Gating } from "#s/features/better-skills/gating";
import { Inline } from "#s/features/better-skills/inline";
import { Runtime } from "#s/features/better-skills/runtime";

export const layer = pipe(
  Effect.map(Config.Service, ({ "better-skills": config }) => {
    if (!config.enabled) return Layer.empty;

    const features = Layer.mergeAll(
      config.expansion ? Expansion.layer : Layer.empty,
      config.gating ? Gating.layer : Layer.empty,
      config.inline ? Inline.layer : Layer.empty,
    ).pipe(Layer.provide(Runtime.layer));

    return Layer.mergeAll(Runtime.layer, features);
  }),
  Layer.unwrap,
);

export { Expansion } from "#s/features/better-skills/expansion";
export { Gating } from "#s/features/better-skills/gating";
export { Inline } from "#s/features/better-skills/inline";
export { Runtime } from "#s/features/better-skills/runtime";
export * as BetterSkills from "./index.ts";
