import {
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Effect, HashMap, Layer, Option, Schema, pipe } from "effect";
import { Config } from "#s/config";
import { Runtime } from "#s/features/better-skills/runtime";
import { Pi } from "@ys-raptor/pi-effect";
import { Catalog } from "./catalog.ts";

const conditionReason = (condition: Catalog.Condition) => {
  const note = Option.getOrUndefined(condition.note);
  if (note !== undefined) return note;

  const command = Option.getOrUndefined(condition.command);
  if (!command) return "not configured (passes by default)";

  const output = Option.getOrElse(condition.output, () => "").trim();
  return `returned ${JSON.stringify(output)}`;
};

const findDecision = (snapshot: Catalog.Snapshot, name: string) =>
  Option.getOrUndefined(HashMap.get(snapshot.byName, name));

const catalogSkill = (skill: Readonly<{ name: string; filePath: string }>) =>
  new Catalog.SkillRef(skill);

const commandSkillName = (value: string) =>
  value.startsWith("skill:") ? value.slice(6) : undefined;

const decodePath = Schema.decodeUnknownOption(Schema.String);

const explicitSkillNames = (text: string, inline: boolean) => {
  const slashName = text.match(/^\/skill:([^\s]+)(?:\s+[\s\S]*)?$/)?.[1];
  if (slashName !== undefined) return [slashName];
  return inline
    ? Runtime.findInlineReferences(text).map(({ name }) => name)
    : [];
};

const overview = (snapshot: Catalog.Snapshot) => {
  const sections: Array<string> = [];
  const states = [
    ["model-accessible", "Model-accessible"],
    ["user-only", "User-only"],
    ["unavailable", "Unavailable"],
  ] as const;

  for (const [state, label] of states) {
    const decisions = snapshot.decisions.filter(
      (decision) => decision.state === state,
    );
    if (decisions.length === 0) continue;

    sections.push(`${label} (${decisions.length}):`);
    for (const decision of decisions) {
      sections.push(`  ${decision.skill.name}`);
      if (state === "model-accessible") continue;

      const condition =
        state === "unavailable"
          ? decision.availability
          : decision.modelInvocation;
      const reason = conditionReason(condition)
        .trim()
        .split(/\s*\n+\s*/)
        .join(" ");
      sections.push(
        `    ${state === "unavailable" ? "available-if " : ""}${reason}`,
      );
    }
  }

  return sections.length === 0 ? "No skills discovered." : sections.join("\n");
};

const explain = (decision: Catalog.Decision) => {
  const formatCondition = (label: string, condition: Catalog.Condition) => {
    const command = Option.getOrUndefined(condition.command);
    const note = Option.getOrUndefined(condition.note);
    const output = Option.getOrUndefined(condition.output);
    if (command === undefined && note === undefined && output === undefined) {
      return ["", `${label}:`, "  command: (not configured)", "  result: true"];
    }

    const invalid = note?.startsWith("frontmatter value must") === true;
    const lines = [
      "",
      `${label}:`,
      `  command: ${command ?? (invalid ? "(invalid value)" : "(not configured)")}`,
    ];
    if (note !== undefined) lines.push(`  detail: ${note}`);
    if (output !== undefined) {
      const trimmed = output.trim();
      lines.push(
        `  output: ${JSON.stringify(
          trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed,
        )}`,
      );
    }
    lines.push(`  result: ${condition.passed}`);
    return lines;
  };

  return [
    `Skill: ${decision.skill.name}`,
    `Path: ${decision.skill.filePath}`,
    `State: ${decision.state}`,
    ...formatCondition("available-if", decision.availability),
    ...formatCondition("model-invocation-if", decision.modelInvocation),
  ].join("\n");
};

const commandSkills = () =>
  Effect.gen(function* () {
    const host = yield* Pi.Host.Service;
    return (yield* host.session.getCommands).flatMap((command) =>
      command.source === "skill"
        ? [
            catalogSkill({
              name: command.name.replace(/^skill:/, ""),
              filePath: command.sourceInfo.path,
            }),
          ]
        : [],
    );
  });

const promptSkills = (
  skills: ReadonlyArray<Pick<Skill, "name" | "filePath">>,
) => skills.map(catalogSkill);

export const layer = pipe(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* Config.Service;
      const inlineEnabled = config["better-skills"].inline;
      const catalog = yield* Catalog.Service;
      const barriers = yield* Pi.Hooks.Barriers.Service;
      const contributions = yield* Pi.Contributions.Service;
      const interceptors = yield* Pi.Hooks.Interceptors.Service;
      const runtime = yield* Runtime.Service;

      const evaluateCommands = (cwd: string) =>
        Effect.flatMap(commandSkills(), (skills) =>
          catalog.evaluate({ cwd, skills }),
        );

      yield* runtime.registerPolicy(
        Effect.fn("Features.BetterSkills.Gating.policy")(function* (input) {
          const snapshot = yield* catalog.evaluate({
            cwd: input.cwd,
            skills: input.skills.map(catalogSkill),
          });
          return new Map(
            snapshot.decisions.map((decision) => [
              decision.skill.filePath,
              decision.state === "unavailable"
                ? {
                    available: false,
                    reason: `Skill ${decision.skill.name} is unavailable: available-if ${conditionReason(decision.availability)}`,
                  }
                : { available: true },
            ]),
          );
        }),
      );

      yield* barriers.handle(
        "session_start",
        Effect.fn("Features.BetterSkills.Gating.sessionStart")(function* () {
          yield* catalog.clear;
          const callback = yield* Pi.Host.Callback;
          const cwd = yield* callback.session.cwd;
          const signal = yield* callback.agent.signal;
          const context = yield* Effect.context<
            Pi.Host.Service | Pi.Host.Callback
          >();
          const runPromise = Effect.runPromiseWith(context);
          yield* callback.ui.addAutocompleteProvider((current) => ({
            triggerCharacters: [...(current.triggerCharacters ?? []), " "],
            async getSuggestions(lines, line, column, options) {
              const suggestions = await current.getSuggestions(
                lines,
                line,
                column,
                options,
              );
              if (suggestions === null) return suggestions;
              if (
                !suggestions.items.some(({ value }) => commandSkillName(value))
              ) {
                return suggestions;
              }
              try {
                const snapshot = await runPromise(evaluateCommands(cwd), {
                  signal,
                });
                const items = suggestions.items.filter(({ value }) => {
                  const name = commandSkillName(value);
                  return (
                    name === undefined ||
                    findDecision(snapshot, name)?.state !== "unavailable"
                  );
                });
                return items.length === 0 ? null : { ...suggestions, items };
              } catch {
                return suggestions;
              }
            },
            applyCompletion: current.applyCompletion.bind(current),
            shouldTriggerFileCompletion: (...args) =>
              current.shouldTriggerFileCompletion?.(...args) ?? true,
          }));
        }),
      );
      yield* interceptors.handle(
        "before_agent_start",
        0,
        Effect.fn("Features.BetterSkills.Gating.beforeAgentStart")(
          function* (event) {
            const callback = yield* Pi.Host.Callback;
            const skills = [...(event.systemPromptOptions.skills ?? [])];
            const snapshot = yield* catalog.evaluate({
              cwd: yield* callback.session.cwd,
              skills: promptSkills(skills),
            });
            const visible: Array<Skill> = [];
            for (const skill of skills) {
              const decision = findDecision(snapshot, skill.name);
              if (decision?.state === "unavailable") continue;
              visible.push({
                ...skill,
                disableModelInvocation:
                  skill.disableModelInvocation ||
                  decision?.state === "user-only",
              });
            }
            visible.sort((left, right) => {
              const byName = left.name.localeCompare(right.name);
              return byName === 0
                ? left.filePath.localeCompare(right.filePath)
                : byName;
            });
            const original = formatSkillsForPrompt(skills);
            const replacement = formatSkillsForPrompt(visible);
            if (original === "" || original === replacement) return;
            return Pi.Hooks.Interceptors.BeforeAgentStartEventResult.make({
              systemPrompt: event.systemPrompt.replace(original, replacement),
            });
          },
        ),
      );
      yield* interceptors.handle(
        "input",
        0,
        Effect.fn("Features.BetterSkills.Gating.input")(function* (event) {
          const names = explicitSkillNames(event.text, inlineEnabled);
          if (names.length === 0) return { action: "continue" as const };

          const callback = yield* Pi.Host.Callback;
          const snapshot = yield* evaluateCommands(yield* callback.session.cwd);
          const decision = names
            .map((name) => findDecision(snapshot, name))
            .find((candidate) => candidate?.state === "unavailable");
          if (decision?.state !== "unavailable") {
            return { action: "continue" as const };
          }

          yield* callback.ui.notify(
            `Skill ${decision.skill.name} is unavailable: available-if ${conditionReason(decision.availability)}`,
            "warning",
          );
          return { action: "handled" as const };
        }),
      );
      yield* interceptors.handle(
        "tool_call",
        0,
        Effect.fn("Features.BetterSkills.Gating.toolCall")(function* (event) {
          const path = decodePath(event.input["path"]);
          if (event.toolName !== "read" || Option.isNone(path)) return;

          const callback = yield* Pi.Host.Callback;
          const cwd = yield* callback.session.cwd;
          yield* evaluateCommands(cwd);

          const decision = yield* catalog.findByPath({
            cwd,
            path: path.value,
          });
          if (
            Option.isNone(decision) ||
            decision.value.state === "model-accessible"
          ) {
            return;
          }

          const condition =
            decision.value.state === "unavailable"
              ? decision.value.availability
              : decision.value.modelInvocation;
          const reason = conditionReason(condition);

          return Pi.Hooks.Interceptors.ToolCallEventResult.make({
            block: true,
            reason:
              decision.value.state === "unavailable"
                ? `available-if ${reason}`
                : inlineEnabled
                  ? `${reason}; invoke it explicitly with /skill:${decision.value.skill.name} or $${decision.value.skill.name}`
                  : `${reason}; invoke it explicitly with /skill:${decision.value.skill.name}`,
          });
        }),
      );
      yield* contributions.command("skills", {
        description: "Inspect or reload better-skills gating state",
        getArgumentCompletions: Effect.fn(
          "Features.BetterSkills.Gating.skills.completions",
        )(function* (prefix) {
          if (prefix.startsWith("explain ")) {
            const query = prefix.slice("explain ".length);
            const matches = (yield* commandSkills())
              .filter((skill) => skill.name.startsWith(query))
              .map((skill) => ({
                value: `explain ${skill.name}`,
                label: skill.name,
              }));
            return matches.length === 0 ? null : matches;
          }

          if (prefix.includes(" ")) return null;
          const matches = [
            {
              value: "explain",
              label: "explain",
              description: "Explain a skill decision",
            },
            {
              value: "reload",
              label: "reload",
              description: "Rerun skill conditions",
            },
          ].filter(({ value }) => value.startsWith(prefix));
          return matches.length === 0 ? null : matches;
        }),
        handler: Effect.fn("Features.BetterSkills.Gating.skills")(
          function* (args) {
            const callback = yield* Pi.Host.Callback;
            const command = yield* Pi.Host.Command;
            const cwd = yield* callback.session.cwd;
            const skills = promptSkills(
              (yield* command.agent.getSystemPromptOptions).skills ?? [],
            );
            const [subcommand, name] = args.trim().split(/\s+/, 2);

            switch (subcommand) {
              case "":
                yield* callback.ui.notify(
                  overview(yield* catalog.evaluate({ cwd, skills })),
                  "info",
                );
                return;

              case "reload": {
                const snapshot = yield* catalog.reload({ cwd, skills });
                yield* callback.ui.notify(
                  `Reloaded ${snapshot.decisions.length} skills.`,
                  "info",
                );
                return;
              }

              case "explain": {
                if (name === undefined) {
                  yield* callback.ui.notify(
                    "Usage: /skills explain <name>",
                    "warning",
                  );
                  return;
                }
                const decision = findDecision(
                  yield* catalog.evaluate({ cwd, skills }),
                  name,
                );
                yield* callback.ui.notify(
                  decision === undefined
                    ? `Unknown skill: ${name}`
                    : explain(decision),
                  decision === undefined ? "warning" : "info",
                );
                return;
              }

              default:
                yield* callback.ui.notify(
                  "Usage: /skills | /skills reload | /skills explain <name>",
                  "warning",
                );
            }
          },
        ),
      });
    }),
  ),
  Layer.provide(Catalog.layer),
);

export { Catalog } from "./catalog.ts";
export * as Gating from "./index.ts";
