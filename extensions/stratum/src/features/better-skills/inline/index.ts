import {
  type AutocompleteItem,
  type AutocompleteProvider,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import { Effect, Layer, pipe } from "effect";
import { Runtime } from "#s/features/better-skills/runtime";
import { Pi } from "@ys-raptor/pi-effect";

const maxSuggestions = 20;
const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

type ResolvedReference = Readonly<{
  reference: Runtime.InlineReference;
  skill: Runtime.SkillRef;
}>;

const rewritePrompt = (
  text: string,
  resolved: ReadonlyArray<ResolvedReference>,
) => {
  let output = "";
  let cursor = 0;
  for (const { reference, skill } of resolved) {
    output += text.slice(cursor, reference.start) + skill.name;
    cursor = reference.end;
  }
  return (output + text.slice(cursor)).trim();
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const barriers = yield* Pi.Hooks.Barriers.Service;
    const interceptors = yield* Pi.Hooks.Interceptors.Service;
    const runtime = yield* Runtime.Service;

    yield* barriers.handle(
      "session_start",
      Effect.fn("Features.BetterSkills.Inline.sessionStart")(function* () {
        const callback = yield* Pi.Host.Callback;
        const cwd = yield* callback.session.cwd;
        const context = yield* Effect.context<
          Pi.Host.Service | Pi.Host.Callback
        >();
        const runPromise = Effect.runPromiseWith(context);

        const skillItems = Effect.fn(
          "Features.BetterSkills.Inline.__skillItems",
        )(function* (query: string) {
          const entries = (yield* runtime.list).map((command) => ({
            command,
            skill: Runtime.skillRef(command),
          }));
          const decisions = yield* runtime.access({
            cwd,
            skills: entries.map(({ skill }) => skill),
          });
          const available = entries.filter(
            ({ skill }) => Runtime.accessFor(decisions, skill).available,
          );
          const matches =
            query === ""
              ? available
              : fuzzyFilter(available, query, ({ skill }) => skill.name);

          return matches.slice(0, maxSuggestions).map(({ command, skill }) => {
            const item = {
              value: `$${skill.name}`,
              label: `$${skill.name}`,
            };
            return command.description === undefined
              ? item
              : { ...item, description: command.description };
          }) satisfies Array<AutocompleteItem>;
        });

        const provider = (
          current: AutocompleteProvider,
        ): AutocompleteProvider => ({
          triggerCharacters: [
            ...new Set([...(current.triggerCharacters ?? []), "$"]),
          ],
          async getSuggestions(lines, cursorLine, cursorColumn, options) {
            const delegate = () =>
              current.getSuggestions(lines, cursorLine, cursorColumn, options);
            const line = lines[cursorLine] ?? "";
            const query = Runtime.findInlineQuery(line.slice(0, cursorColumn));
            if (query === undefined) return delegate();

            try {
              const items = await runPromise(skillItems(query), {
                signal: options.signal,
              });
              if (items.length > 0) return { prefix: `$${query}`, items };
            } catch {
              // Preserve built-in completion when lookup is cancelled.
            }
            return delegate();
          },
          applyCompletion: current.applyCompletion.bind(current),
          shouldTriggerFileCompletion: (...arguments_) =>
            current.shouldTriggerFileCompletion?.(...arguments_) ?? true,
        });

        yield* callback.ui.addAutocompleteProvider(provider);
      }),
    );

    yield* interceptors.handle(
      "input",
      10,
      Effect.fn("Features.BetterSkills.Inline.input")(function* (event) {
        const references = Runtime.findInlineReferences(event.text);
        if (references.length === 0) return { action: "continue" as const };

        const callback = yield* Pi.Host.Callback;
        const skills = new Map(
          (yield* runtime.list).map((command) => {
            const skill = Runtime.skillRef(command);
            return [skill.name, skill] as const;
          }),
        );
        const resolved = references.flatMap((reference) => {
          const skill = skills.get(reference.name);
          return skill === undefined ? [] : [{ reference, skill }];
        });
        if (resolved.length === 0) return { action: "continue" as const };

        return yield* pipe(
          Effect.gen(function* () {
            const cwd = yield* callback.session.cwd;
            const decisions = yield* runtime.access({
              cwd,
              skills: resolved.map(({ skill }) => skill),
            });
            const unavailable = resolved.find(
              ({ skill }) => !Runtime.accessFor(decisions, skill).available,
            );
            if (unavailable !== undefined) {
              const decision = Runtime.accessFor(decisions, unavailable.skill);
              yield* callback.ui.notify(
                decision.reason ??
                  `Skill ${unavailable.skill.name} is unavailable`,
                "warning",
              );
              return { action: "handled" as const };
            }

            const skills = new Map(
              resolved.map(({ skill }) => [skill.filePath, skill]),
            ).values();
            const blocks = yield* Effect.forEach(skills, (skill) =>
              runtime.render(skill, cwd),
            );
            const prompt = rewritePrompt(event.text, resolved);
            const result = {
              action: "transform" as const,
              text:
                prompt === ""
                  ? blocks.join("\n\n")
                  : `${blocks.join("\n\n")}\n\n${prompt}`,
            };
            return event.images === undefined
              ? result
              : { ...result, images: event.images };
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
  }),
);

export * as Inline from "./index.ts";
