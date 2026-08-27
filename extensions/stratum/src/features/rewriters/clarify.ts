import { Data, Effect, Layer } from "effect";
import * as Registry from "./register.ts";

const SYSTEM_PROMPT = `You rewrite rough, plain-language user prompts into clear, precise prompts for a coding agent.

Your job is terminology compression and clarity, not invention.

Rules:
1. Keep the user's intent exactly. Do not add features, constraints, stack choices, or preferences they did not state.
2. When a well-known technical term matches what the user described, use that term instead of the long description.
   Examples of the kind of compression wanted:
   - "remember old card positions, measure new ones, animate between them" → "FLIP animation"
   - "thumbnail grows into the large image on the next screen so it feels like the same image" → "shared-element transition"
   - "one small part working end-to-end from UI through backend and database" → "vertical slice"
   - "show the new state right away, then fix it if the server fails" → "optimistic update"
   - "wait until the user stops typing before searching" → "debounce the search input"
   Apply the same idea in any domain: use the standard name for the pattern, algorithm, UX move, architecture choice, protocol, or process the user is describing.
3. Prefer short, exact terms over long explanations. If a term is right, use it.
4. Preserve all concrete details: product names, file names, paths, numbers, constraints, UI copy, error text, and acceptance criteria.
5. Keep the rewrite as a ready-to-send user prompt. Do not wrap it in quotes. Do not add a preamble like "Here is the rewritten prompt".
6. Use the same language the user wrote in (English stays English, Italian stays Italian, etc.).
7. If the original is already precise, make only light cleanup. Do not invent jargon or force terms that do not fit.
8. Structure multi-part asks with short bullets or numbered steps when that makes the ask clearer.
9. Do not answer the request. Only rewrite the prompt.
10. Output only the rewritten prompt text.`;

class ClarifyFailed extends Data.TaggedError("ClarifyFailed")<{
  readonly message: string;
}> {}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* Registry.Service;

    const rewrite = Effect.fn("Features.Rewriters.Clarify.rewrite")(function* (
      input: string,
      context: Registry.Invocation,
    ) {
      const model = context.model;
      if (model === undefined) {
        return yield* new ClarifyFailed({ message: "No model is available for Clarify." });
      }
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          context.modelRegistry.complete(
            model,
            {
              systemPrompt: SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: input }],
                  timestamp: Date.now(),
                },
              ],
            },
            { signal },
          ),
        catch: (cause) => new ClarifyFailed({ message: errorMessage(cause) }),
      });
      if (response.stopReason === "aborted") return null;
      return response.content
        .filter((content): content is { type: "text"; text: string } => content.type === "text")
        .map((content) => content.text)
        .join("\n")
        .trim();
    });

    yield* registry.register("clarify", {
      description: "Rewrite a rough idea into a precise technical prompt",
      loadingMessage: "Clarifying prompt…",
      errorMessage: "Clarify failed.",
      rewrite,
    });
  }),
);

export * as Clarify from "./clarify.ts";
