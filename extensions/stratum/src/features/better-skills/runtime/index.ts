import {
  parseFrontmatter,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  pipe,
} from "effect";
import { Pi } from "@ys-raptor/pi-effect";

export type SkillCommand = ReturnType<ExtensionAPI["getCommands"]>[number];

export type SkillRef = Readonly<{
  name: string;
  filePath: string;
}>;

export type InlineReference = Readonly<{
  name: string;
  start: number;
  end: number;
}>;

export type AccessDecision = Readonly<{
  available: boolean;
  reason?: string;
}>;

export type AccessInput = Readonly<{
  cwd: string;
  skills: ReadonlyArray<SkillRef>;
}>;

export type AccessPolicy = (
  input: AccessInput,
) => Effect.Effect<ReadonlyMap<string, AccessDecision>>;

export type BodyTransformInput = Readonly<{
  body: string;
  cwd: string;
  skill: SkillRef;
}>;

export type BodyTransformer = (
  input: BodyTransformInput,
) => Effect.Effect<string, Cause.UnknownError>;

export type Interface = Readonly<{
  access: (
    input: AccessInput,
  ) => Effect.Effect<ReadonlyMap<string, AccessDecision>>;
  list: Effect.Effect<ReadonlyArray<SkillCommand>>;
  registerPolicy: (policy: AccessPolicy) => Effect.Effect<void>;
  registerTransformer: (transformer: BodyTransformer) => Effect.Effect<void>;
  render: (
    skill: SkillRef,
    cwd: string,
  ) => Effect.Effect<string, Cause.UnknownError>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.BetterSkills.Runtime",
) {}

const referencePattern =
  /(?<![\\$A-Za-z0-9_-])\$([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?![a-z0-9-])/g;
const partialReferencePattern = /(?:^|[^\\$A-Za-z0-9_-])\$([a-z0-9-]*)$/;

export const findInlineReferences = (
  text: string,
): ReadonlyArray<InlineReference> =>
  Array.from(text.matchAll(referencePattern), (match) => {
    const name = match[1] ?? "";
    const start = match.index;
    return { name, start, end: start + name.length + 1 };
  });

export const findInlineQuery = (textBeforeCursor: string): string | undefined =>
  textBeforeCursor.match(partialReferencePattern)?.[1];

export const skillRef = (command: SkillCommand): SkillRef => ({
  name: command.name.replace(/^skill:/, ""),
  filePath: command.sourceInfo.path,
});

export const accessFor = (
  decisions: ReadonlyMap<string, AccessDecision>,
  skill: SkillRef,
): AccessDecision => decisions.get(skill.filePath) ?? { available: true };

const xmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const host = yield* Pi.Host.Service;
    const paths = yield* Path.Path;
    const policy = yield* Ref.make<AccessPolicy | undefined>(undefined);
    const transformer = yield* Ref.make<BodyTransformer | undefined>(undefined);

    const registerPolicy: Interface["registerPolicy"] = Effect.fn(
      "Features.BetterSkills.Runtime.registerPolicy",
    )((value) => Ref.set(policy, value));

    const registerTransformer: Interface["registerTransformer"] = Effect.fn(
      "Features.BetterSkills.Runtime.registerTransformer",
    )((value) => Ref.set(transformer, value));

    const access: Interface["access"] = Effect.fn(
      "Features.BetterSkills.Runtime.access",
    )(function* (input) {
      const current = yield* Ref.get(policy);
      if (current !== undefined) return yield* current(input);
      return new Map<string, AccessDecision>(
        input.skills.map((skill) => [skill.filePath, { available: true }]),
      );
    });

    const list: Interface["list"] = pipe(
      host.session.getCommands,
      Effect.map((commands) =>
        commands.filter((command) => command.source === "skill"),
      ),
      Effect.withSpan("Features.BetterSkills.Runtime.list"),
    );

    const render: Interface["render"] = Effect.fn(
      "Features.BetterSkills.Runtime.render",
    )(function* (skill, cwd) {
      const decision = accessFor(
        yield* access({ cwd, skills: [skill] }),
        skill,
      );
      if (!decision.available) {
        return yield* new Cause.UnknownError(
          decision,
          decision.reason ?? `Skill ${skill.name} is unavailable`,
        );
      }

      const source = yield* pipe(
        files.readFileString(skill.filePath),
        Effect.mapError(
          (error) =>
            new Cause.UnknownError(
              error,
              `Could not read skill ${skill.name}: ${String(error)}`,
            ),
        ),
      );
      const parsed = yield* Effect.try({
        try: () => parseFrontmatter(source).body.trim(),
        catch: (error) =>
          new Cause.UnknownError(
            error,
            `Could not parse skill ${skill.name}: ${String(error)}`,
          ),
      });
      const transform = yield* Ref.get(transformer);
      const body =
        transform === undefined
          ? parsed
          : yield* transform({ body: parsed, cwd, skill });
      return `<skill name="${xmlAttribute(skill.name)}" location="${xmlAttribute(skill.filePath)}">\nReferences are relative to ${paths.dirname(skill.filePath)}.\n\n${body}\n</skill>`;
    });

    return Service.of({
      access,
      list,
      registerPolicy,
      registerTransformer,
      render,
    });
  }),
);

export * as Runtime from "./index.ts";
