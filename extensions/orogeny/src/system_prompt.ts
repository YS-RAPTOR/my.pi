import { Effect, FileSystem, Layer, Path } from "effect";
import { Pi } from "@ys-raptor/pi-effect";

const projectContext = "<project_context>";

const insert = (systemPrompt: string, notebookContext: string) => {
  if (notebookContext === "" || systemPrompt.includes("<notebook_context>")) return systemPrompt;
  return systemPrompt.includes(projectContext)
    ? systemPrompt.replace(projectContext, `${notebookContext}\n\n${projectContext}`)
    : `${systemPrompt}\n\n${notebookContext}`;
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const interceptors = yield* Pi.Hooks.Interceptors.Service;
    const file = yield* paths.fromFileUrl(new URL("./system_prompt.md", import.meta.url));
    const notebookContext = (yield* files.readFileString(file)).trim();

    yield* interceptors.handle(
      "before_agent_start",
      100,
      Effect.fn("Orogeny.SystemPrompt.beforeAgentStart")((event) => {
        const systemPrompt = insert(event.systemPrompt, notebookContext);
        return systemPrompt === event.systemPrompt
          ? Effect.void
          : Effect.succeed(
              Pi.Hooks.Interceptors.BeforeAgentStartEventResult.make({ systemPrompt }),
            );
      }),
    );
  }),
);
