# Activity

Activity reports agent state to Stratty/Ghostty and optionally runs an inhibition command while the agent is active. Every setting has a default:

```json
{
  "activity": {
    "enabled": true,
    "terminal-reporting": true,
    "inhibit-command": "systemd-inhibit --what=sleep --mode=block --who='Stratum Pi' --why='Pi agent active' sleep infinity"
  }
}
```

`terminal-reporting` controls both state reporting and the attention bell. Set `inhibit-command` to an empty string to run no inhibition process. The configured command is executed through `bash -lc` and is stopped when activity settles or Stratum shuts down.
