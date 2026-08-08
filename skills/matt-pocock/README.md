# Matt Pocock skills

This directory is a curated Pi adaptation of [mattpocock/skills](https://github.com/mattpocock/skills). It is not a complete mirror. Preserve the local invocation policy, `spec/` workflow, and bundled references when syncing upstream changes.

## Provenance

- Managed reference: `~/.references/github/mattpocock--skills/tracking-branch-main`
- Last synchronized upstream commit: `84fdeffd12f2ee307994d1eb6feb48173b6e0502`
- Upstream version at that commit: `1.2.3`
- Initial local import commit: `4d75bd51441b90a5d76c0ee3cc61dfa7848f2103`

Use the `reference-manager` skill before inspecting or refreshing upstream. The managed reference is read-only task input; make changes only in this directory.

## Installed skills

| Local skill                     | Upstream source                                    | Pi invocation | Local adaptation                                                                          |
| ------------------------------- | -------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `code-review`                   | `skills/engineering/code-review`                   | User only     | Specifications come only from `spec/`.                                                    |
| `diagnosing-bugs`               | `skills/engineering/diagnosing-bugs`               | User only     | Invocation differs from upstream.                                                         |
| `grilling`                      | `skills/productivity/grilling`                     | Model         | None.                                                                                     |
| `grill-me`                      | `skills/productivity/grill-me`                     | User only     | None.                                                                                     |
| `grill-with-docs`               | `skills/engineering/grill-with-docs`               | User only     | Domain-modeling is bundled as local reference files.                                      |
| `handoff`                       | `skills/productivity/handoff`                      | User only     | None.                                                                                     |
| `improve-codebase-architecture` | `skills/engineering/improve-codebase-architecture` | User only     | Codebase-design and domain-modeling are bundled as local reference files.                 |
| `prototype`                     | `skills/engineering/prototype`                     | User only     | Prototype pointers are recorded in the relevant file under `spec/`, not an issue tracker. |
| `research`                      | `skills/engineering/research`                      | User only     | Invocation differs from upstream.                                                         |
| `resolving-merge-conflicts`     | `skills/engineering/resolving-merge-conflicts`     | Model         | Primary specification documents live under `spec/`.                                       |
| `teach`                         | `skills/productivity/teach`                        | User only     | None.                                                                                     |
| `to-spec`                       | `skills/engineering/to-spec`                       | User only     | Writes Markdown under `spec/` instead of publishing to an issue tracker.                  |
| `wait-what`                     | `skills/productivity/wait-what`                    | User only     | None.                                                                                     |
| `writing-for-agents`            | `skills/productivity/writing-for-agents`           | User only     | Upstream makes this model-invoked; this collection deliberately does not.                 |

Only `grilling` and `resolving-merge-conflicts` are model-invokable. Preserve `disable-model-invocation: true` on every other installed skill, even when upstream's policy differs.

Upstream skills not listed here are intentionally not installed. Treat new or promoted upstream skills as a separate curation decision, not an automatic sync step.

## Local reference layout

`codebase-design` and `domain-modeling` were removed as independently invokable local skills. Their content is retained beside the user-invoked parent skills that need it, following the existing adjacent-reference convention.

### `grill-with-docs`

| Local reference      | Upstream source                                                    |
| -------------------- | ------------------------------------------------------------------ |
| `DOMAIN-MODELING.md` | `skills/engineering/domain-modeling/SKILL.md`, without frontmatter |
| `ADR-FORMAT.md`      | `skills/engineering/domain-modeling/ADR-FORMAT.md`                 |
| `CONTEXT-FORMAT.md`  | `skills/engineering/domain-modeling/CONTEXT-FORMAT.md`             |

`grill-with-docs/SKILL.md` must point to `DOMAIN-MODELING.md`, not invoke `/domain-modeling`.

### `improve-codebase-architecture`

| Local reference      | Upstream source                                                    |
| -------------------- | ------------------------------------------------------------------ |
| `CODEBASE-DESIGN.md` | `skills/engineering/codebase-design/SKILL.md`, without frontmatter |
| `DEEPENING.md`       | `skills/engineering/codebase-design/DEEPENING.md`                  |
| `DESIGN-IT-TWICE.md` | `skills/engineering/codebase-design/DESIGN-IT-TWICE.md`            |
| `DOMAIN-MODELING.md` | `skills/engineering/domain-modeling/SKILL.md`, without frontmatter |
| `ADR-FORMAT.md`      | `skills/engineering/domain-modeling/ADR-FORMAT.md`                 |
| `CONTEXT-FORMAT.md`  | `skills/engineering/domain-modeling/CONTEXT-FORMAT.md`             |

Keep links inside the copied codebase-design references local: references to its original `SKILL.md` become `CODEBASE-DESIGN.md`. The parent `SKILL.md` and `HTML-REPORT.md` must point to the bundled files rather than `/codebase-design` or `/domain-modeling`.

When domain-modeling changes upstream, update both bundled copies. When codebase-design changes, update the copy under `improve-codebase-architecture`.

## Other deliberate differences

- Pi uses `SKILL.md` frontmatter. Upstream `agents/openai.yaml` files are Codex UI/policy metadata and are intentionally omitted.
- The local specification system is file-based: `spec/` is canonical. Do not replace it with upstream's issue-tracker workflow in `code-review`, `to-spec`, `prototype`, or `resolving-merge-conflicts`.
- Keep upstream wording unchanged wherever no local adaptation is required. Make the smallest possible substitution where a local path, invocation policy, or bundled reference differs.

## Update procedure

1. Load and follow the `reference-manager` skill. Validate the managed reference's origin, branch, clean status, and current commit; then fast-forward `main`.
2. Diff upstream from the **Last synchronized upstream commit** recorded above:

   ```bash
   REF="$HOME/.references/github/mattpocock--skills/tracking-branch-main"
   git -C "$REF" diff 84fdeffd12f2ee307994d1eb6feb48173b6e0502..main -- skills/
   ```

3. Inventory additions, removals, renames, `SKILL.md` changes, supporting-reference changes, and invocation-policy changes. New skills require an explicit curation decision.
4. Apply upstream changes to the installed skills while preserving the local adaptations documented here. Propagate shared dependency changes into every bundled copy.
5. Do not copy `agents/openai.yaml`. Do not restore standalone `codebase-design` or `domain-modeling` skills unless explicitly requested.
6. Verify:
   - only `grilling` and `resolving-merge-conflicts` are model-invokable;
   - no parent skill invokes the removed `/codebase-design` or `/domain-modeling` skills;
   - all relative Markdown links resolve, ignoring example links inside fenced code blocks;
   - `git diff --check` passes;
   - unrelated working-tree changes remain untouched.
7. Update the recorded synchronized commit and version only after the merge and verification are complete. Report the exact managed reference path and resolved commit.
