# expansion

Expansion evaluates `` !`command` `` expressions in skill bodies:

```markdown
Current branch: !`git branch --show-current`
```

Commands run with `bash -lc` from the current project directory and use `better-skills.command-timeout-ms`, which defaults to ten seconds. The transformer applies to skills loaded through `/skill:name`, `$skill-name`, or the read tool.
