# Shell

Shell is Stratum's internal PTY resource service. Every setting has a default:

```json
{
  "shell": {
    "enabled": true,
    "default-wait-timeout-seconds": 30,
    "max-read-lines": 2000,
    "terminal": {
      "columns": 175,
      "rows": 75,
      "history-lines": 100000
    }
  }
}
```

Disabling Shell omits its Effect service. The terminal settings configure every tmux-backed PTY, while `max-read-lines` limits paginated history reads. Shell does not register Pi tools.
