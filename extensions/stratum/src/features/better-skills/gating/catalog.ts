import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  Array as Arr,
  Cache,
  Cause,
  Config as EffectConfig,
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  pipe,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Config } from "#s/config";
import { Shell } from "#s/features/better-skills/shell";

export type SkillState = "model-accessible" | "user-only" | "unavailable";

export class SkillRef extends Data.Class<{
  readonly name: string;
  readonly filePath: string;
}> {}

export class Condition extends Data.Class<{
  readonly passed: boolean;
  readonly command: Option.Option<string>;
  readonly output: Option.Option<string>;
  readonly note: Option.Option<string>;
}> {}

export class Decision extends Data.Class<{
  readonly skill: SkillRef;
  readonly state: SkillState;
  readonly availability: Condition;
  readonly modelInvocation: Condition;
}> {}

export class Snapshot extends Data.Class<{
  readonly cwd: string;
  readonly decisions: ReadonlyArray<Decision>;
  readonly byName: HashMap.HashMap<string, Decision>;
}> {}

const Frontmatter = Schema.Struct({
  "available-if": Schema.OptionFromOptionalKey(Schema.String),
  "model-invocation-if": Schema.OptionFromOptionalKey(Schema.String),
  "disable-model-invocation": Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
});

type Frontmatter = typeof Frontmatter.Type;

const decodeFrontmatter = Schema.decodeUnknownEffect(Frontmatter);

class CacheKey extends Data.Class<{
  readonly cwd: string;
  readonly skill: SkillRef;
}> {}

export type EvaluateInput = Readonly<{
  cwd: string;
  skills: ReadonlyArray<SkillRef>;
}>;

export type FindByPathInput = Readonly<{
  cwd: string;
  path: string;
}>;

export type Interface = Readonly<{
  evaluate: (input: EvaluateInput) => Effect.Effect<Snapshot>;
  reload: (input: EvaluateInput) => Effect.Effect<Snapshot>;
  findByPath: (input: FindByPathInput) => Effect.Effect<Option.Option<Decision>>;
  clear: Effect.Effect<void>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.BetterSkills.Gating.Catalog",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service;
    const commandTimeoutMs = config["better-skills"]["command-timeout-ms"];
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const latest = yield* Ref.make<Snapshot | undefined>(undefined);
    const home = yield* EffectConfig.string("HOME");

    const cacheKey = (cwd: string, skill: SkillRef) =>
      new CacheKey({
        cwd,
        skill: new SkillRef({
          name: skill.name,
          filePath: paths.resolve(skill.filePath),
        }),
      });

    const canonicalPath = (path: string) =>
      pipe(
        files.realPath(path),
        Effect.orElseSucceed(() => path),
      );

    const condition = (
      passed: boolean,
      options: Readonly<{
        command?: Option.Option<string>;
        output?: Option.Option<string>;
        note?: Option.Option<string>;
      }> = {},
    ) =>
      new Condition({
        passed,
        command: options.command ?? Option.none(),
        output: options.output ?? Option.none(),
        note: options.note ?? Option.none(),
      });

    const evaluateCondition = Effect.fn("Features.BetterSkills.Gating.Catalog.__evaluateCondition")(
      function* (command: string, cwd: string) {
        const execution = yield* pipe(
          Shell.run(processes, command, cwd),
          Effect.timeout(Duration.millis(commandTimeoutMs)),
          Effect.result,
        );
        if (Result.isFailure(execution)) {
          if (Cause.isTimeoutError(execution.failure)) {
            return yield* execution.failure;
          }
          return condition(false, {
            command: Option.some(command),
            note: Option.some(
              execution.failure instanceof globalThis.Error
                ? execution.failure.message
                : String(execution.failure),
            ),
          });
        }
        const [output, exitCode] = execution.success;
        if (exitCode !== 0) {
          const detail = output === "" ? "(no output)" : output;
          return condition(false, {
            command: Option.some(command),
            note: Option.some(`${detail}\n\nCommand exited with code ${exitCode}`),
          });
        }
        const normalized = output === "(no output)" ? "" : output;
        return condition(normalized.trim() === "true", {
          command: Option.some(command),
          output: Option.some(normalized),
        });
      },
    );

    const evaluateSkill = Effect.fn("Features.BetterSkills.Gating.Catalog.__evaluateSkill")(
      function* (skill: SkillRef, frontmatter: Frontmatter, cwd: string) {
        const availableIf = frontmatter["available-if"];
        const availability = Option.isSome(availableIf)
          ? yield* evaluateCondition(availableIf.value, cwd)
          : condition(true);

        if (!availability.passed) {
          return new Decision({
            skill,
            state: "unavailable",
            availability,
            modelInvocation: condition(false, {
              command: frontmatter["model-invocation-if"],
              note: Option.some("available-if did not pass"),
            }),
          });
        }

        if (frontmatter["disable-model-invocation"]) {
          return new Decision({
            skill,
            state: "user-only",
            availability,
            modelInvocation: condition(false, {
              command: frontmatter["model-invocation-if"],
              note: Option.some("disable-model-invocation is true"),
            }),
          });
        }

        const modelInvocationIf = frontmatter["model-invocation-if"];
        const modelInvocation = Option.isSome(modelInvocationIf)
          ? yield* evaluateCondition(modelInvocationIf.value, cwd)
          : condition(true);

        return new Decision({
          skill,
          state: modelInvocation.passed ? "model-accessible" : "user-only",
          availability,
          modelInvocation,
        });
      },
    );

    const cache = yield* Cache.make<CacheKey, Decision>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: ({ cwd, skill }) =>
        pipe(
          files.readFileString(skill.filePath),
          Effect.flatMap((source) => Effect.try(() => parseFrontmatter(source).frontmatter)),
          Effect.flatMap(decodeFrontmatter),
          Effect.flatMap((frontmatter) => evaluateSkill(skill, frontmatter, cwd)),
          Effect.catch((error) => {
            const detail = error instanceof globalThis.Error ? error.message : String(error);
            const note = `skill file could not be read or parsed: ${detail}`;
            return Effect.succeed(
              new Decision({
                skill,
                state: "unavailable",
                availability: condition(false, {
                  note: Option.some(note),
                }),
                modelInvocation: condition(false, {
                  note: Option.some(note),
                }),
              }),
            );
          }),
        ),
    });

    const evaluate: Interface["evaluate"] = Effect.fn(
      "Features.BetterSkills.Gating.Catalog.evaluate",
    )(function* (input) {
      const decisions = yield* Effect.forEach(
        input.skills,
        (skill) => Cache.get(cache, cacheKey(input.cwd, skill)),
        { concurrency: "unbounded" },
      );
      const snapshot = new Snapshot({
        cwd: input.cwd,
        decisions,
        byName: HashMap.fromIterable(
          decisions.map((decision) => [decision.skill.name, decision] as const),
        ),
      });
      yield* Ref.set(latest, snapshot);
      return snapshot;
    });

    const reload: Interface["reload"] = Effect.fn("Features.BetterSkills.Gating.Catalog.reload")(
      function* (input) {
        yield* Effect.forEach(
          input.skills,
          (skill) => Cache.invalidate(cache, cacheKey(input.cwd, skill)),
          { discard: true },
        );
        return yield* evaluate(input);
      },
    );

    const findByPath: Interface["findByPath"] = Effect.fn(
      "Features.BetterSkills.Gating.Catalog.findByPath",
    )(function* (input) {
      const snapshot = yield* Ref.get(latest);
      if (snapshot === undefined || snapshot.cwd !== input.cwd) {
        return Option.none();
      }
      const requested = input.path.startsWith("@") ? input.path.slice(1) : input.path;
      const canonical = yield* canonicalPath(
        paths.resolve(input.cwd, requested.replace(/^~(?=\/|$)/, home)),
      );
      return yield* Effect.findFirst(Arr.reverse(snapshot.decisions), (decision) =>
        pipe(
          canonicalPath(decision.skill.filePath),
          Effect.map((path) => path === canonical),
        ),
      );
    });

    const clear: Interface["clear"] = pipe(
      Cache.invalidateAll(cache),
      Effect.andThen(Ref.set(latest, undefined)),
      Effect.withSpan("Features.BetterSkills.Gating.Catalog.clear"),
    );

    return Service.of({ clear, evaluate, findByPath, reload });
  }),
);

export * as Catalog from "./catalog.ts";
