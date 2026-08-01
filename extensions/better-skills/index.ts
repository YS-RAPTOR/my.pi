import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  formatSkillsForPrompt,
  isReadToolResult,
  isToolCallEventType,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  SkillCatalog,
  type CatalogSnapshot,
  type Condition,
  type SkillDecision,
  type SkillRef,
  type SkillState,
} from "./catalog.ts";
import { interpolateCommands } from "./shell.ts";

const STATE_LABELS: Record<SkillState, string> = {
  "model-accessible": "Model-accessible",
  "user-only": "User-only",
  unavailable: "Unavailable",
};
function conditionReason(condition: Condition): string {
  if (condition.note) return condition.note;
  if (!condition.command) return "not configured (passes by default)";
  return `returned ${JSON.stringify(condition.output?.trim() ?? "")}`;
}

function unavailableReason(decision: SkillDecision): string {
  return `available-if ${conditionReason(decision.availability)}`;
}

function overview(snapshot: CatalogSnapshot): string {
  const sections: string[] = [];

  for (const [state, label] of Object.entries(STATE_LABELS)) {
    const skills = snapshot.decisions.filter(
      (decision) => decision.state === state,
    );
    if (skills.length === 0) continue;

    sections.push(`${label} (${skills.length}):`);
    for (const decision of skills) {
      sections.push(`  ${decision.skill.name}`);
      if (state === "model-accessible") continue;

      const condition = state === "unavailable"
        ? decision.availability
        : decision.modelInvocation;
      const reason = conditionReason(condition).trim().split(/\n+/).at(-1);
      const prefix = state === "unavailable" ? "available-if " : "";
      sections.push(`    ${prefix}${reason}`);
    }
  }

  return sections.length ? sections.join("\n") : "No skills discovered.";
}

function explain(decision: SkillDecision): string {
  const lines = [
    `Skill: ${decision.skill.name}`,
    `Path: ${decision.skill.filePath}`,
    `State: ${decision.state}`,
  ];

  const addCondition = (label: string, condition: Condition) => {
    lines.push("", `${label}:`);
    if (
      condition.command === undefined &&
      condition.note === undefined &&
      condition.output === undefined
    ) {
      lines.push("  command: (not configured)", "  result: true");
      return;
    }

    const invalid = condition.note?.startsWith("frontmatter value must");
    lines.push(
      `  command: ${condition.command ?? (invalid ? "(invalid value)" : "(not configured)")}`,
    );
    if (condition.note) lines.push(`  detail: ${condition.note}`);
    if (condition.output !== undefined) {
      let output = condition.output.trim();
      if (output.length > 500) output = `${output.slice(0, 500)}…`;
      lines.push(`  output: ${JSON.stringify(output)}`);
    }
    lines.push(`  result: ${condition.passed}`);
  };

  addCondition("available-if", decision.availability);
  addCondition("model-invocation-if", decision.modelInvocation);
  return lines.join("\n");
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export default function betterSkills(pi: ExtensionAPI) {
  const catalog = new SkillCatalog();

  const commandSkills = (): SkillRef[] =>
    pi
      .getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => ({
        name: command.name.replace(/^skill:/, ""),
        filePath: command.sourceInfo.path,
      }));

  const promptSkills = (skills: Skill[]): SkillRef[] =>
    skills.map(({ name, filePath }) => ({ name, filePath }));

  const evaluate = (
    skills: SkillRef[],
    ctx: ExtensionContext,
    force = false,
  ): Promise<CatalogSnapshot> =>
    catalog.evaluate(skills, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      context: ctx,
      force,
    });

  const evaluateCommands = (ctx: ExtensionContext, force = false) =>
    evaluate(commandSkills(), ctx, force);

  const interpolate = (content: string, ctx: ExtensionContext) =>
    interpolateCommands(content, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      context: ctx,
    });

  pi.on("session_start", (_event, ctx) => {
    catalog.clear();
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: [...(current.triggerCharacters ?? []), " "],
      async getSuggestions(lines, line, column, options) {
        const input = (lines[line] ?? "").slice(0, column);
        const isSlashCommand = input.trimStart().startsWith("/");
        const suggestions = await current.getSuggestions(
          lines,
          line,
          column,
          options,
        );
        if (!suggestions || !isSlashCommand) return suggestions;

        try {
          const snapshot = await evaluateCommands(ctx);
          const items = suggestions.items.filter((item) => {
            if (!item.value.startsWith("skill:")) return true;
            return snapshot.byName.get(item.value.slice(6))?.state !==
              "unavailable";
          });
          return items.length ? { ...suggestions, items } : null;
        } catch {
          return suggestions;
        }
      },
      applyCompletion(lines, line, column, item, prefix) {
        return current.applyCompletion(lines, line, column, item, prefix);
      },
      shouldTriggerFileCompletion(lines, line, column) {
        return current.shouldTriggerFileCompletion?.(lines, line, column) ?? true;
      },
    }));
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const skills = event.systemPromptOptions.skills ?? [];
    const snapshot = await evaluate(promptSkills(skills), ctx);
    const visible: Skill[] = [];

    for (const skill of skills) {
      const state = snapshot.byName.get(skill.name)?.state;
      if (state === "unavailable") continue;
      visible.push({
        ...skill,
        disableModelInvocation:
          skill.disableModelInvocation || state === "user-only",
      });
    }
    visible.sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) return byName;
      return left.filePath.localeCompare(right.filePath);
    });

    const original = formatSkillsForPrompt(skills);
    const replacement = formatSkillsForPrompt(visible);
    if (original && original !== replacement) {
      return {
        systemPrompt: event.systemPrompt.replace(original, replacement),
      };
    }
  });

  pi.on("input", async (event, ctx) => {
    const match = event.text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
    const skillName = match?.[1];
    if (!skillName) return { action: "continue" };

    const decision = (await evaluateCommands(ctx)).byName.get(skillName);
    if (!decision) return { action: "continue" };
    if (decision.state === "unavailable") {
      ctx.ui.notify(
        `Skill ${skillName} is unavailable: ${unavailableReason(decision)}`,
        "warning",
      );
      return { action: "handled" };
    }

    try {
      const { body } = parseFrontmatter(
        await readFile(decision.skill.filePath, "utf8"),
      );
      const expanded = await interpolate(body.trim(), ctx);
      const block = `<skill name="${xmlAttribute(skillName)}" location="${xmlAttribute(decision.skill.filePath)}">\nReferences are relative to ${dirname(decision.skill.filePath)}.\n\n${expanded}\n</skill>`;
      const args = match[2]?.trim();
      return {
        action: "transform",
        text: args ? `${block}\n\n${args}` : block,
        ...(event.images ? { images: event.images } : {}),
      };
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return { action: "handled" };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("read", event)) return;
    await evaluateCommands(ctx);
    const decision = await catalog.findByPath(event.input.path, ctx.cwd);
    if (!decision || decision.state === "model-accessible") return;
    if (decision.state === "unavailable") {
      return { block: true, reason: unavailableReason(decision) };
    }

    const reason = conditionReason(decision.modelInvocation);
    return {
      block: true,
      reason: `${reason}; invoke it explicitly with /skill:${decision.skill.name}`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isReadToolResult(event) || typeof event.input.path !== "string")
      return;
    const decision = await catalog.findByPath(event.input.path, ctx.cwd);
    if (decision?.state !== "model-accessible") return;

    try {
      const source = await readFile(decision.skill.filePath, "utf8");
      const frontmatter = source.match(
        /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
      )?.[0];
      const offset = typeof event.input.offset === "number"
        ? event.input.offset
        : 1;
      let frontmatterLines = Math.max(
        0,
        (frontmatter?.match(/\n/g)?.length ?? 0) - offset + 1,
      );
      const content = [];

      for (const item of event.content) {
        if (item.type !== "text") {
          content.push(item);
          continue;
        }

        let bodyStart = 0;
        while (frontmatterLines > 0 && bodyStart < item.text.length) {
          const newline = item.text.indexOf("\n", bodyStart);
          bodyStart = newline === -1 ? item.text.length : newline + 1;
          frontmatterLines--;
        }
        content.push({
          ...item,
          text: item.text.slice(0, bodyStart) +
            await interpolate(item.text.slice(bodyStart), ctx),
        });
      }
      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  });

  pi.registerCommand("skills", {
    description: "Inspect or refresh better-skills state",
    getArgumentCompletions(prefix) {
      if (prefix.startsWith("explain ")) {
        const query = prefix.slice("explain ".length);
        const matches = commandSkills()
          .filter((skill) => skill.name.startsWith(query))
          .map((skill) => ({
            value: `explain ${skill.name}`,
            label: skill.name,
          }));
        return matches.length ? matches : null;
      }

      if (prefix.includes(" ")) return null;
      const matches = [
        {
          value: "explain",
          label: "explain",
          description: "Explain a skill decision",
        },
        {
          value: "refresh",
          label: "refresh",
          description: "Rerun skill conditions",
        },
      ].filter((item) => item.value.startsWith(prefix));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const [subcommand, name] = args.trim().split(/\s+/, 2);
      const skills = promptSkills(ctx.getSystemPromptOptions().skills ?? []);

      switch (subcommand) {
        case "":
          ctx.ui.notify(overview(await evaluate(skills, ctx)), "info");
          return;

        case "refresh": {
          const snapshot = await evaluate(skills, ctx, true);
          ctx.ui.notify(`Refreshed ${snapshot.decisions.length} skills.`, "info");
          return;
        }

        case "explain": {
          if (!name) {
            ctx.ui.notify("Usage: /skills explain <name>", "warning");
            return;
          }
          const decision = (await evaluate(skills, ctx)).byName.get(name);
          ctx.ui.notify(
            decision ? explain(decision) : `Unknown skill: ${name}`,
            decision ? "info" : "warning",
          );
          return;
        }

        default:
          ctx.ui.notify(
            "Usage: /skills | /skills refresh | /skills explain <name>",
            "warning",
          );
      }
    },
  });
}
