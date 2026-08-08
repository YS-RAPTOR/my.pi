# expansion

Expansion evaluates `` !`command` `` expressions in skill bodies:

```markdown
Current branch: !`git branch --show-current`
```

Commands run with `bash -lc` from the current project directory and time out after ten seconds. The transformer applies to skills loaded through `/skill:name`, `$skill-name`, or the read tool.
