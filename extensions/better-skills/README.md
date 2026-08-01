# better-skills

`better-skills` adds trusted, context-sensitive model visibility and command interpolation to every skill discovered by Pi, regardless of where the skill came from.

## Frontmatter

Both optional fields contain trusted shell commands. Pi's built-in Bash implementation runs them from the current project directory. A condition passes only when the command succeeds and its complete output, after trimming, is exactly `true`.

```markdown
---
name: nixos-development
description: Work with NixOS configurations and flakes.
available-if: |
  command -v nix >/dev/null && printf true
model-invocation-if: |
  test -f flake.nix && printf true
---
```

- `available-if`: when false, the skill is unavailable to both the user and model.
- `model-invocation-if`: when false, the skill is hidden from and blocked for the model, but explicit `/skill:name` invocation still works.
- Missing fields pass by default.
- Standard `disable-model-invocation: true` remains authoritative and makes an otherwise available skill user-only.

## Commands

- `/skills` shows skills grouped as model-accessible, user-only, or unavailable.
- `/skills explain <name>` shows the commands, outputs, and reasons behind one skill's state.
- `/skills refresh` clears cached decisions and reruns conditions for all currently discovered skills.

Use Pi's `/reload` when adding or removing skill files. `/skills refresh` is for reevaluating conditions on the resources Pi has already discovered.

## Interpolation

Use Claude-style `` !`command` `` expressions in a skill body:

```markdown
Current branch: !`git branch --show-current`

Changes:

!`git diff --stat`
```

`better-skills` executes each expression whenever the skill is explicitly invoked or read by the model, then substitutes the output without modifying `SKILL.md`. It uses Pi's Bash implementation, including timeout, cancellation, output truncation, and full-output temporary files.

## Current enforcement model

Pi 0.83 does not let extensions remove or mutate discovered skill resources. `better-skills` therefore enforces decisions by:

- filtering the skill section sent to the model;
- blocking model reads of user-only and unavailable `SKILL.md` files;
- intercepting explicit `/skill:name` invocation for unavailable skills;
- filtering unavailable skills from interactive autocomplete.

Lower-level command enumeration APIs may still list unavailable skills. Invocation remains blocked.
