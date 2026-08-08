# inline

Reference skills anywhere in a prompt with `$skill-name`:

```text
Use $grilling to challenge this plan, then apply $code-review.
```

Typing `$` opens skill autocomplete. Referenced skill blocks are placed before the rewritten user prompt so Pi renders them like `/skill:name`; `$skill-name` becomes `skill-name` in the prompt. Repeated references load a skill only once.

Inline loading works independently. When gating is enabled, unavailable skills are blocked and omitted from autocomplete. When expansion is enabled, command expressions in inline-loaded skill bodies are interpolated.
