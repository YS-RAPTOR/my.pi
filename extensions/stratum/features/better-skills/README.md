# better-skills

`better-skills` combines three independently configurable skill features over a shared runtime:

- `inline`: reference skills anywhere with `$skill-name` and complete them after `$`.
- `gating`: evaluate skill availability and model-invocation conditions.
- `expansion`: evaluate `` !`command` `` expressions when skill content is loaded.

Configure the feature in `~/.pi/agent/stratum.json`:

```json
{
  "better-skills": {
    "enabled": true,
    "inline": true,
    "gating": true,
    "expansion": true
  }
}
```

The main switch disables the complete feature. Each subfeature can otherwise be toggled independently.

Input interception is ordered as follows:

1. Gating checks explicit `/skill:name` and `$skill-name` references.
2. Inline expansion prepends unique skill blocks and rewrites `$skill-name` as `skill-name` in the user prompt.
3. Slash expansion handles complete `/skill:name` invocations.

The shared runtime applies enabled gating policies and expansion transforms regardless of which syntax loaded a skill.
