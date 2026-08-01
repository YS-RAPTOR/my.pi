import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  parseFrontmatter,
  type SkillFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { runCommand, type CommandOptions } from "./shell.ts";

export type SkillState = "model-accessible" | "user-only" | "unavailable";
export type SkillRef = { name: string; filePath: string };
export type Condition = {
  passed: boolean;
  command?: string;
  output?: string;
  note?: string;
};
export type SkillDecision = {
  skill: SkillRef;
  state: SkillState;
  availability: Condition;
  modelInvocation: Condition;
};
export type CatalogSnapshot = {
  cwd: string;
  decisions: SkillDecision[];
  byName: Map<string, SkillDecision>;
  byPath: Map<string, SkillDecision>;
};

type Frontmatter = SkillFrontmatter & {
  "available-if"?: unknown;
  "model-invocation-if"?: unknown;
};
type EvaluateOptions = CommandOptions & { force?: boolean };

async function evaluateCondition(
  value: unknown,
  options: CommandOptions,
): Promise<Condition> {
  if (value === undefined) return { passed: true };
  if (typeof value !== "string") {
    return {
      passed: false,
      note: "frontmatter value must be a Bash command string",
    };
  }

  try {
    const output = await runCommand(value, options);
    return { passed: output.trim() === "true", command: value, output };
  } catch (error) {
    return {
      passed: false,
      command: value,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

function skipped(value: unknown, note: string): Condition {
  return {
    passed: false,
    ...(typeof value === "string" ? { command: value } : {}),
    note,
  };
}

async function canonicalPath(path: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()));
  return realpath(absolute).catch(() => absolute);
}

export class SkillCatalog {
  private decisions = new Map<string, SkillDecision>();
  private snapshot: CatalogSnapshot | undefined;

  clear(): void {
    this.decisions.clear();
    this.snapshot = undefined;
  }

  async evaluate(
    inputs: SkillRef[],
    options: EvaluateOptions,
  ): Promise<CatalogSnapshot> {
    const skills = inputs.map(({ name, filePath }) => ({
      name,
      filePath: resolve(filePath),
    }));
    const decisions: SkillDecision[] = [];
    for (const skill of skills) {
      const key = `${options.cwd}\u0000${skill.name}\u0000${skill.filePath}`;
      const cached = !options.force && this.decisions.get(key);
      if (cached) {
        decisions.push(cached);
        continue;
      }

      try {
        const { frontmatter } = parseFrontmatter<Frontmatter>(
          await readFile(skill.filePath, "utf8"),
        );
        const availability = await evaluateCondition(
          frontmatter["available-if"],
          options,
        );
        let modelInvocation: Condition;
        let state: SkillState;
        if (!availability.passed) {
          modelInvocation = skipped(
            frontmatter["model-invocation-if"],
            "available-if did not pass",
          );
          state = "unavailable";
        } else if (frontmatter["disable-model-invocation"] === true) {
          modelInvocation = skipped(
            frontmatter["model-invocation-if"],
            "disable-model-invocation is true",
          );
          state = "user-only";
        } else {
          modelInvocation = await evaluateCondition(
            frontmatter["model-invocation-if"],
            options,
          );
          state = modelInvocation.passed ? "model-accessible" : "user-only";
        }

        this.decisions.set(key, {
          skill,
          state,
          availability,
          modelInvocation,
        });
      } catch (error) {
        const note = `skill file could not be read or parsed: ${error instanceof Error ? error.message : String(error)}`;
        this.decisions.set(key, {
          skill,
          state: "unavailable",
          availability: { passed: false, note },
          modelInvocation: skipped(undefined, note),
        });
      }
      decisions.push(this.decisions.get(key)!);
    }

    this.snapshot = {
      cwd: options.cwd,
      decisions,
      byName: new Map(decisions.map((item) => [item.skill.name, item])),
      byPath: new Map(
        await Promise.all(
          decisions.map(
            async (item) =>
              [
                await canonicalPath(item.skill.filePath, options.cwd),
                item,
              ] as const,
          ),
        ),
      ),
    };
    return this.snapshot;
  }

  async findByPath(
    path: string,
    cwd: string,
  ): Promise<SkillDecision | undefined> {
    if (!this.snapshot || this.snapshot.cwd !== cwd) return undefined;
    return this.snapshot.byPath.get(
      await canonicalPath(path.startsWith("@") ? path.slice(1) : path, cwd),
    );
  }
}
