import {
  Cause,
  Config as EffectConfig,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  pipe,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Config } from "#s/config";
import { Runtime } from "#s/features/better-skills/runtime";
import { Shell } from "#s/features/better-skills/shell";
import { Pi } from "@ys-raptor/pi-effect";

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const isTextContent = Schema.is(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);
const decodePath = Schema.decodeUnknownOption(Schema.String);
const decodeOffset = Schema.decodeUnknownOption(Schema.Finite);

const skipLines = (text: string, lines: number) => {
  let start = 0;
  let remaining = lines;
  while (remaining > 0 && start < text.length) {
    const newline = text.indexOf("\n", start);
    start = newline === -1 ? text.length : newline + 1;
    remaining -= 1;
  }
  return { remaining, start };
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service;
    const commandTimeoutMs = config["better-skills"]["command-timeout-ms"];
    const files = yield* FileSystem.FileSystem;
    const interceptors = yield* Pi.Hooks.Interceptors.Service;
    const paths = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* Runtime.Service;
    const home = yield* EffectConfig.string("HOME");

    const canonicalPath = (path: string) =>
      pipe(
        files.realPath(path),
        Effect.orElseSucceed(() => path),
      );

    const interpolate = Effect.fn("Features.BetterSkills.Expansion.interpolate")(function* (
      content: string,
      cwd: string,
    ) {
      const expanded = yield* Effect.reduce(
        content.matchAll(/!`([^`\n]+)`/g),
        () => ({ output: "", cursor: 0 }),
        (state, match) =>
          pipe(
            Shell.run(processes, match[1] ?? "", cwd),
            Effect.timeout(Duration.millis(commandTimeoutMs)),
            Effect.flatMap(([output, exitCode]) => {
              if (exitCode !== 0) {
                const detail = output === "" ? "(no output)" : output;
                return Effect.fail(
                  new Cause.UnknownError(
                    exitCode,
                    `${detail}\n\nCommand exited with code ${exitCode}`,
                  ),
                );
              }
              return Effect.succeed((output === "(no output)" ? "" : output).trimEnd());
            }),
            Effect.mapError(
              (error) =>
                new Cause.UnknownError(
                  error,
                  `Interpolation failed for ${match[0]}: ${errorMessage(error)}`,
                ),
            ),
            Effect.map((replacement) => ({
              output: state.output + content.slice(state.cursor, match.index) + replacement,
              cursor: match.index + match[0].length,
            })),
          ),
      );
      return expanded.output + content.slice(expanded.cursor);
    });

    yield* runtime.registerTransformer(({ body, cwd }) => interpolate(body, cwd));

    yield* interceptors.handle(
      "input",
      20,
      Effect.fn("Features.BetterSkills.Expansion.input")(function* (event) {
        const match = event.text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
        if (match === null) return { action: "continue" as const };
        const [, skillName = "", arguments_] = match;

        const callback = yield* Pi.Host.Callback;
        const command = (yield* runtime.list).find(
          (candidate) => Runtime.skillRef(candidate).name === skillName,
        );
        if (command === undefined) return { action: "continue" as const };
        const skill = Runtime.skillRef(command);

        return yield* pipe(
          Effect.gen(function* () {
            const block = yield* runtime.render(skill, yield* callback.session.cwd);
            const skillArguments = arguments_?.trim();
            const result = {
              action: "transform" as const,
              text: skillArguments ? `${block}\n\n${skillArguments}` : block,
            };
            return event.images === undefined ? result : { ...result, images: event.images };
          }),
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* callback.ui.notify(errorMessage(error), "error");
              return { action: "handled" as const };
            }),
          ),
        );
      }),
    );

    yield* interceptors.handle(
      "tool_result",
      0,
      Effect.fn("Features.BetterSkills.Expansion.toolResult")(function* (event) {
        const path = decodePath(event.input["path"]);
        if (event.toolName !== "read" || Option.isNone(path)) return;

        const host = yield* Pi.Host.Service;
        const callback = yield* Pi.Host.Callback;
        const cwd = yield* callback.session.cwd;
        const requested = path.value.startsWith("@") ? path.value.slice(1) : path.value;
        const expandedPath = requested.replace(/^~(?=\/|$)/, home);
        const absolute = paths.resolve(cwd, expandedPath);
        const canonical = yield* canonicalPath(absolute);
        const skill = yield* Effect.findFirst(yield* host.session.getCommands, (command) => {
          if (command.source !== "skill") return Effect.succeed(false);
          const location = paths.resolve(command.sourceInfo.path);
          return pipe(
            canonicalPath(location),
            Effect.map((candidate) => candidate === canonical),
          );
        });
        if (Option.isNone(skill)) return;

        return yield* pipe(
          Effect.gen(function* () {
            const source = yield* files.readFileString(skill.value.sourceInfo.path);
            const frontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
            const offset = Option.getOrElse(decodeOffset(event.input["offset"]), () => 1);
            let remaining = Math.max(0, (frontmatter?.match(/\n/g)?.length ?? 0) - offset + 1);
            const content: Array<unknown> = [];

            for (const item of event.content) {
              if (!isTextContent(item)) {
                content.push(item);
                continue;
              }

              const skipped = skipLines(item.text, remaining);
              remaining = skipped.remaining;
              content.push({
                ...item,
                text:
                  item.text.slice(0, skipped.start) +
                  (yield* interpolate(item.text.slice(skipped.start), cwd)),
              });
            }

            return Pi.Hooks.Interceptors.ToolResultEventResult.make({
              content,
            });
          }),
          Effect.catch((error) =>
            Effect.succeed(
              Pi.Hooks.Interceptors.ToolResultEventResult.make({
                content: [
                  {
                    type: "text",
                    text: errorMessage(error),
                  },
                ],
                isError: true,
              }),
            ),
          ),
        );
      }),
    );
  }),
);

export * as Expansion from "./index.ts";
