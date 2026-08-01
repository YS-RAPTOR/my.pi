import {
  createBashToolDefinition,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type CommandOptions = {
  cwd: string;
  signal: AbortSignal | undefined;
  context: ExtensionContext;
};

export async function runCommand(
  command: string,
  options: CommandOptions,
): Promise<string> {
  const result = await createBashToolDefinition(options.cwd, {
    exposeSessionEnvironment: false,
  }).execute(
    "better-skills",
    { command, timeout: 10 },
    options.signal,
    undefined,
    options.context,
  );
  const output = result.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
  return output === "(no output)" ? "" : output;
}

export async function interpolateCommands(
  content: string,
  options: CommandOptions,
): Promise<string> {
  const matches = [...content.matchAll(/!`([^`\n]+)`/g)];
  let expanded = "";
  let cursor = 0;

  for (const match of matches) {
    const [expression, command] = match;
    if (!command || match.index === undefined) continue;
    expanded += content.slice(cursor, match.index);

    try {
      expanded += (await runCommand(command, options)).trimEnd();
    } catch (error) {
      throw new Error(
        `Interpolation failed for ${expression}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    cursor = match.index + expression.length;
  }

  return expanded + content.slice(cursor);
}
