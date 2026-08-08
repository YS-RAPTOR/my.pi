# gating

Gating controls whether discovered skills are available to users and models.

## Frontmatter

```markdown
---
available-if: command -v nix >/dev/null && printf true
model-invocation-if: test -f flake.nix && printf true
---
```

- `available-if`: when false, the skill is unavailable to both users and models.
- `model-invocation-if`: when false, the skill remains explicitly invokable but is hidden from and blocked for the model.
- `disable-model-invocation: true`: makes an otherwise available skill user-only.

Gating applies consistently to `/skill:name`, inline `$skill-name` references, autocomplete, model-visible skill metadata, and direct skill-file reads.

## Commands

- `/skills` shows skills grouped by state.
- `/skills explain <name>` explains a decision.
- `/skills reload` reevaluates skill conditions.
