## Reference Management

**IMPORTANT:** Use the `reference-manager` skill before inspecting external GitHub repositories or package artifacts. Cache and reuse references under `~/.references`; do not clone them into this repository or inspect project `node_modules` as a substitute.

Treat cached references as read-only task inputs. Follow the skill to validate or refresh tracking references before use, and report the exact reference path and resolved commit or package version.

## Effect Best Practices

**IMPORTANT:** Consult these managed reference repositories before writing Effect code:

1. Search `~/.references/github/anomalyco--opencode/tracking-branch-dev` for production application patterns and conventions.
2. Search `~/.references/github/usefulsoftwareco--executor/tracking-branch-main` for focused Effect architecture and implementation examples.
3. Search `~/.references/github/effect-ts--effect/tracking-branch-main` to verify APIs, types, tests, and runtime implementation details.

Prefer patterns demonstrated by OpenCode and Executor over inventing new conventions. Verify that examples match the Effect version used by this project before applying them.
