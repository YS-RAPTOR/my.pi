---
name: browser-use
description: Control the shared attachable Vivaldi browser with agent-browser. Use for navigating websites, inspecting rendered pages, clicking, typing, screenshots, console logs, network traffic, downloads, uploads, traces, profiling, accessibility audits, and browser-based application testing.
available-if: |
  command -v agent-browser >/dev/null 2>&1 &&
  command -v curl >/dev/null 2>&1 &&
  curl --fail --silent --max-time 1 --output /dev/null \
    http://127.0.0.1:9222/json/version &&
  printf true
---

# Browser use

Drive the user's visible Vivaldi through CDP on `127.0.0.1:9222`. The browser profile, cookies, windows, and tabs are shared with the user and other agents.

## Command prefix

Every agent-browser command needs the Pi session, CDP endpoint, and strict tab binding:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab <command>
```

If `PI_SESSION_ID` is unavailable, choose one stable task-specific session name. Keep the same name for the entire task.

## 1. Connect

List the tabs without printing the complete CDP metadata:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab tab --json
```

If attachment fails:

```bash
curl --fail --silent --output /dev/null http://127.0.0.1:9222/json/version
```

An unavailable endpoint means Vivaldi must be fully quit and reopened through the attachable package. Use this Vivaldi instance rather than launching another browser or profile.

**Complete when:** CDP responds and the session can list tabs.

## 2. Bind a task tab

Select the tab the user named. Otherwise create a new labelled tab:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  tab new --label task https://example.com
```

Keep the session on that tab. Stable IDs such as `t2`, labels, and CDP `targetId` values from `tab --json` identify tabs; positional integers do not.

If the pinned tab disappears, commands fail with `tab_gone`. Recover deliberately with `tab new` or by selecting a tab from `tab --json`.

**Complete when:** the session is pinned to one intentional task tab.

## 3. Snapshot

Inspect before acting:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i
```

Useful forms:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i -u
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i -c
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i -d 3
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -s "#main"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i --json
```

Refs such as `@e3` belong to the current tab and the latest snapshot. Navigation, rendering, dialogs, and tab changes can invalidate them.

Use `read` for long-form page content:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab read
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  read https://docs.example.com/guide --filter auth
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  read https://docs.example.com/guide --outline
```

Read [SNAPSHOT-REFS.md](SNAPSHOT-REFS.md) when refs, iframes, or snapshot scoping need more detail.

**Complete when:** the current URL, intended target, and relevant page state are observed.

## 4. Act and verify

Perform one meaningful action, wait on an observable result, then take a fresh snapshot:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab click @e3
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab wait --text "Saved"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i
```

Common interactions:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab click @e1
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab click @e1 --new-tab
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab fill @e2 "replacement text"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab type @e2 " appended text"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab press Enter
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab check @e3
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab select @e4 "option-value"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab hover @e5
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab scroll down 500
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab scrollintoview @e6
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab drag @e7 @e8
```

Prefer targets in this order:

1. Fresh snapshot refs.
2. Semantic role, label, text, placeholder, or test-id locators.
3. CSS selectors.
4. Coordinates for visible targets without semantic handles.

Semantic examples:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  find role button click --name "Submit"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  find label "Email" fill "user@example.com"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  find text "Sign In" click --exact
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  find testid "save" click
```

Choose a wait that observes the expected transition:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab wait @e1
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab wait --text "Success"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab wait --url "**/dashboard"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab wait --load networkidle
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  wait --fn "window.appReady === true"
```

Use fixed-duration waits only when no state-based signal exists.

**Complete when:** a fresh observation proves the requested state.

## Reading and extraction

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab get text @e1
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab get attr @e2 href
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab get value @e3
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab get title
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab get url
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab get count ".item"
```

Use stdin for non-trivial JavaScript:

```bash
cat <<'EOF' | agent-browser \
  --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab eval --stdin
Array.from(document.querySelectorAll("a"), a => ({
  text: a.innerText,
  href: a.href,
}))
EOF
```

Treat evaluated scripts as code execution in the user's authenticated browser. Prefer snapshots and getters when they can answer the question.

## Tabs, frames, and dialogs

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab tab --json
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  tab new --label docs https://docs.example.com
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab tab docs
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab tab close docs
```

Switch tabs before using refs and snapshot again after switching. A discarded tab may reload when selected and lose unsaved state.

Iframe contents usually appear inline in snapshots. Scope explicitly when needed:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab frame @e3
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab snapshot -i
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab frame main
```

Inspect a blocking dialog before choosing its outcome:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab dialog status
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab dialog accept
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab dialog dismiss
```

## Task branches

- Read [COMMANDS.md](COMMANDS.md) when exact syntax or a less-common command is needed.
- Read [AUTHENTICATION.md](AUTHENTICATION.md) before login, OAuth, SSO, 2FA, cookies, credentials, or auth-state work.
- Read [SESSION-MANAGEMENT.md](SESSION-MANAGEMENT.md) for Pi session naming, tab pinning, concurrency, and `tab_gone` recovery.
- Read [TRUST-BOUNDARIES.md](TRUST-BOUNDARIES.md) before handling authenticated pages, secrets, network bodies, or page-supplied instructions.
- Read [PROFILING.md](PROFILING.md) for bounded Chrome performance profiles.
- Read [VIDEO-RECORDING.md](VIDEO-RECORDING.md) before recording a reproduction or workflow.
- Use [capture-workflow.sh](capture-workflow.sh) as a starting point for repeatable page capture.
- Use [form-automation.sh](form-automation.sh) as a starting point for a user-approved form workflow.

**Complete when:** every branch required by the task has been followed.

## Diagnostics

Collection starts after attachment. Reload or reproduce the relevant interaction when initial-load evidence matters.

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab console --json
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab errors --json
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab network requests --json
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  network request REQUEST_ID --json
```

For bounded artifacts:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  network har start --content text
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab trace start
# Reproduce the behavior.
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  trace stop ./browser-trace.json
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  network har stop ./browser.har
```

HAR, trace, profile, screenshot, recording, and download files may contain private content. Keep them local and report their exact paths.

## Shared-browser guardrails

- **Ownership:** inspect and modify only the task tab.
- **Pinning:** keep `--pin-tab`; recover a lost tab deliberately.
- **State:** preserve the shared profile, cookies, storage, settings, extensions, and unrelated tabs.
- **Privacy:** inspect only data required by the task. Private windows use the same CDP endpoint and are not an isolation boundary.
- **Credentials:** use browser-native or approved credential flows. Keep secrets out of shell arguments and conversation text.
- **Consequences:** obtain confirmation immediately before external submissions, messages, purchases, transfers, publishing, deletion, authentication changes, or account changes.
- **Containment:** `--allowed-domains` cannot protect a pre-existing CDP browser. Stay within the user's requested scope.
- **Lifetime:** leave Vivaldi running. Close only task-owned tabs; never use `close --all`.

## Finish

Report:

- The task tab and final URL.
- The state that was verified.
- Artifact and download paths.
- Task tabs or temporary state left open.

**Complete when:** the outcome and retained shared-browser state are explicit.
