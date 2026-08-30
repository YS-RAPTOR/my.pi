# Video recording

Record a bounded interaction in the task tab for debugging, reproduction, or documentation.

Examples omit the required shared-browser options. Add `--session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab` to every agent-browser command.

## Record

Navigate and verify the starting state before recording:

```bash
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser record start ./reproduction.webm

# Perform the bounded workflow.

agent-browser record stop
```

Use `record restart ./take-2.webm` to stop the current recording and immediately begin another.

**Complete when:** recording is stopped and the output file exists.

## Reproduction evidence

Start before the first action required to reproduce the issue. Add short waits only when a human reviewer needs time to see transitions:

```bash
agent-browser record start ./issue-001.webm
agent-browser screenshot ./issue-001-before.png
agent-browser click @e1
agent-browser wait 500
agent-browser screenshot ./issue-001-after.png
agent-browser record stop
```

Capture the smallest sequence that proves the behavior. Static defects usually need only a screenshot.

**Complete when:** the recording and reproduction steps describe the same bounded sequence.

## Failure cleanup

Stop recording on success and failure:

```bash
agent-browser record stop
```

Leave Vivaldi running and preserve the task tab when it contains useful failure state.

## Files

- Recordings use WebM.
- Long recordings consume disk space and add browser overhead.
- Videos and screenshots can expose autofilled fields, account data, URLs, and page content.

Keep artifacts local, inspect only what the task requires, and report exact paths.
