# Codex Runway

`codex-runway` shows ChatGPT Codex subscription quota in Pi's footer.

## Display

The status contains only a quota bar and reset countdowns:

```text
[██████████|██████████|██████████|▀▀▀▀▀▀▀▀▀▀|⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀] 3.8h/6.7d
```

- Every column represents 2% remaining quota.
- A dual-window response uses the upper half for the primary window and lower half for the weekly window.
- A lone window is assumed to be weekly and uses a full-height bar.
- Separators divide the runway into 20% groups.
- Primary and weekly reset countdowns are always shown when both windows exist. Missing reset timestamps render as `?`.

## Colors

Colors come from Pi's active theme:

| Remaining | State     | Theme color       |
| --------: | --------- | ----------------- |
|   51–100% | healthy   | `thinkingMinimal` |
|    16–50% | moderate  | `thinkingMedium`  |
|     6–15% | watch     | `thinkingHigh`    |
|      1–5% | critical  | `thinkingXhigh`   |
|        0% | exhausted | `thinkingMax`     |

The primary window controls the foreground. The weekly window independently tints the runway background. Brackets remain outside the background; internal separators share it.

## Runtime behavior

The feature is active only for the `openai-codex` provider. It reads subscription quota from Pi's existing Codex authentication. By default it refreshes every 30 seconds with a 15-second request timeout. A cached report remains visible through four transient failures; the fifth displays `error`. These values are configurable through the footer's `runway` settings. Missing subscription auth or quota displays `n/a`.

This implementation is informed by [`@llblab/pi-codex-usage`](https://github.com/llblab/pi-codex-usage), which is MIT-licensed. Codex Runway is intentionally narrower and does not include its app-server fallback, Spark bucket, Telegram integration, provisional-full-report delay, or package-specific status label.
