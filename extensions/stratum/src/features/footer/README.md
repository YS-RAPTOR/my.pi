# Footer

Stratum's footer is configured in `~/.pi/agent/stratum.json`. Every setting has a default:

```json
{
  "footer": {
    "enabled": true,
    "cwd": true,
    "model": true,
    "tokens": true,
    "cache": true,
    "cost": true,
    "statuses": true,
    "context": {
      "enabled": true,
      "warning-percent": 70,
      "error-percent": 90
    },
    "runway": {
      "enabled": true,
      "request-timeout-ms": 15000,
      "refresh-interval-ms": 30000,
      "cached-failure-limit": 5
    }
  }
}
```

- `enabled` installs the complete custom footer. When disabled, Pi keeps its built-in footer.
- `cwd`, `model`, `tokens`, `cache`, `cost`, and `statuses` control their corresponding sections.
- `context` controls context usage display and its warning/error thresholds.
- `runway` controls Codex subscription quota polling, display, request timeout, refresh interval, and cached-report failure tolerance.
