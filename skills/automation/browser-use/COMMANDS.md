# Command reference

The examples show agent-browser command syntax without repeating the required global options. When executing any command, add:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab <command>
```

Use `agent-browser <command> --help` when a flag is not covered here.

## Navigation

```bash
agent-browser open <url>      # Navigate the task tab
agent-browser read            # Read rendered active-tab content
agent-browser read <url>      # Fetch agent-readable text
agent-browser read <url> --filter auth
agent-browser read <url> --outline
agent-browser back
agent-browser forward
agent-browser reload
agent-browser pushstate <url> # SPA client-side navigation
```

`open` navigates the tab bound to the Pi session. It does not need to launch another browser.

## Snapshot

```bash
agent-browser snapshot
agent-browser snapshot -i
agent-browser snapshot -i -u
agent-browser snapshot -i -c
agent-browser snapshot -i -d 3
agent-browser snapshot -s "#main"
agent-browser snapshot -i --json
```

Read [SNAPSHOT-REFS.md](SNAPSHOT-REFS.md) for ref lifecycle and iframe behavior.

## Interaction

```bash
agent-browser click @e1
agent-browser click @e1 --new-tab
agent-browser dblclick @e1
agent-browser focus @e1
agent-browser fill @e2 "text"
agent-browser type @e2 "text"
agent-browser press Enter
agent-browser press Control+a
agent-browser keydown Shift
agent-browser keyup Shift
agent-browser hover @e1
agent-browser check @e1
agent-browser uncheck @e1
agent-browser select @e1 "value"
agent-browser select @e1 "a" "b"
agent-browser scroll down 500
agent-browser scrollintoview @e1
agent-browser drag @e1 @e2
agent-browser upload @e1 ./file.pdf
```

A covered click fails before dispatch and names the covering element. Snapshot again, handle the overlay, and retry with the new ref.

## Semantic locators

```bash
agent-browser find role button click --name "Submit"
agent-browser find role heading text --name "Skills"
agent-browser find text "Sign In" click
agent-browser find text "Sign In" click --exact
agent-browser find label "Email" fill "user@example.com"
agent-browser find placeholder "Search" fill "query"
agent-browser find alt "Logo" click
agent-browser find title "Close" click
agent-browser find testid "submit-btn" click
agent-browser find first ".item" click
agent-browser find last ".item" click
agent-browser find nth 2 "a" hover
```

## Read element state

```bash
agent-browser get text @e1
agent-browser get html @e1
agent-browser get value @e1
agent-browser get attr @e1 href
agent-browser get title
agent-browser get url
agent-browser get count ".item"
agent-browser get box @e1
agent-browser get styles @e1

agent-browser is visible @e1
agent-browser is enabled @e1
agent-browser is checked @e1
```

## Wait

```bash
agent-browser wait @e1
agent-browser wait --text "Success"
agent-browser wait --url "**/dashboard"
agent-browser wait --load networkidle
agent-browser wait --load domcontentloaded
agent-browser wait --fn "window.ready === true"
agent-browser wait 1000
```

Prefer observable state over fixed milliseconds.

## Screenshots, PDFs, downloads, and recordings

```bash
agent-browser screenshot
agent-browser screenshot ./page.png
agent-browser screenshot --full ./full-page.png
agent-browser screenshot --annotate ./annotated.png
agent-browser pdf ./page.pdf
agent-browser download @e5 ./report.xlsx

agent-browser record start ./reproduction.webm
agent-browser record stop
agent-browser record restart ./take-2.webm
```

Read [VIDEO-RECORDING.md](VIDEO-RECORDING.md) before recording. Uploading or downloading can disclose or introduce data; verify the exact file and destination.

## Tabs and windows

```bash
agent-browser tab --json
agent-browser tab new [url]
agent-browser tab new --label docs [url]
agent-browser tab t2
agent-browser tab docs
agent-browser tab close
agent-browser tab close t2
agent-browser tab close docs
agent-browser window new
```

Tab IDs are stable strings such as `t2`; positional integers are not accepted. Labels must be unique within the session. CDP `targetId` values from `tab --json` remain stable across daemon restarts.

With `--pin-tab`, a closed bound tab produces `tab_gone`. `tab new` and `tab --json` remain available for deliberate recovery.

Switching to a discarded tab can reload it and reports `"revived": true`. A tab blocked by a dialog reports `"dialogBlocked": true`.

## Frames

```bash
agent-browser frame @e3
agent-browser frame "#iframe"
agent-browser frame main
```

One iframe level is normally inlined into snapshots. Cross-origin iframe content may remain inaccessible.

## Dialogs

```bash
agent-browser dialog status
agent-browser dialog accept
agent-browser dialog accept "prompt text"
agent-browser dialog dismiss
```

`alert` and `beforeunload` are auto-accepted by default. `confirm` and `prompt` require an explicit outcome.

## JavaScript

```bash
agent-browser eval "document.title"
agent-browser eval -b "<base64>"
agent-browser eval --stdin
```

Use `--stdin` for non-trivial scripts:

```bash
cat <<'EOF' | agent-browser \
  --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab eval --stdin
Array.from(document.querySelectorAll("a"), a => a.href)
EOF
```

## Mouse and keyboard

Use these only when snapshot refs and semantic locators cannot target the control:

```bash
agent-browser mouse move 100 200
agent-browser mouse down left
agent-browser mouse up left
agent-browser mouse wheel 100
agent-browser keyboard inserttext "text"
agent-browser keyboard type "text"
```

## Tab-scoped emulation

These commands change the task tab's behavior. Restore changed state after testing when practical:

```bash
agent-browser set viewport 1920 1080
agent-browser set viewport 1920 1080 2
agent-browser set device "iPhone 14"
agent-browser set geo 37.7749 -122.4194
agent-browser set offline on
agent-browser set offline off
agent-browser set media dark
agent-browser set media light reduced-motion
agent-browser set headers '{"X-Key":"value"}'
agent-browser set credentials username password
```

Keep credentials and private headers out of shell arguments. Let the user handle them in Vivaldi instead.

## Cookies and storage

```bash
agent-browser cookies
agent-browser cookies set name value
agent-browser cookies set --curl <file>
agent-browser storage local
agent-browser storage local key
agent-browser storage local set key value
```

These operate on the shared Vivaldi profile. Read [AUTHENTICATION.md](AUTHENTICATION.md) and [TRUST-BOUNDARIES.md](TRUST-BOUNDARIES.md) first. Clearing or exporting state requires explicit approval.

## Network

```bash
agent-browser network requests
agent-browser network requests --filter api
agent-browser network requests --type xhr,fetch
agent-browser network requests --method POST --status 2xx
agent-browser network request <requestId>
agent-browser network requests --clear

agent-browser network route "**/api/*" --abort
agent-browser network route "**/data.json" --body '{"mock":true}'
agent-browser network unroute

agent-browser network har start
agent-browser network har start --content text
agent-browser network har start --content none
agent-browser network har stop ./capture.har
```

Collection begins after attachment. Reproduce the interaction when initial traffic matters. Request details and HAR files can contain credentials and private bodies.

Network routes alter the shared task tab. Use them only for requested testing and remove them afterward.

## Console and page errors

```bash
agent-browser console
agent-browser console --clear
agent-browser errors
agent-browser errors --clear
agent-browser highlight @e1
```

## Traces and profiling

```bash
agent-browser trace start
agent-browser trace stop ./browser-trace.json

agent-browser profiler start
agent-browser profiler start --categories "devtools.timeline,v8.execute,blink.user_timing"
agent-browser profiler stop ./browser-profile.json
```

Read [PROFILING.md](PROFILING.md) before performance capture.

## Accessibility

```bash
agent-browser a11y
agent-browser a11y --tags wcag2a,wcag2aa
agent-browser a11y --selector "#main"
agent-browser a11y --json
```

The embedded axe-core audit works through CDP and includes iframe selector paths where available. Keep definite violations separate from `incomplete` checks requiring human review.

## Required global options

```bash
--session "pi-${PI_SESSION_ID}" # One agent-browser daemon namespace per Pi session
--cdp 9222                     # Shared loopback Vivaldi endpoint
--pin-tab                      # Strict task-tab binding
--json                         # Structured output when useful
```

Keep the first three options on every command. Do not use launch options, profiles, restore state, providers, proxies, extensions, or domain allowlists with this pre-existing Vivaldi process.
