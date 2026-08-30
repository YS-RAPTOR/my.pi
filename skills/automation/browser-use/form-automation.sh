#!/usr/bin/env bash
set -euo pipefail

: "${PI_SESSION_ID:?PI_SESSION_ID is required}"

form_url="${1:?Usage: $0 <form-url>}"
session="pi-${PI_SESSION_ID}"
tab_label="form-$$"

agent-browser --session "$session" --cdp 9222 --pin-tab \
    tab new --label "$tab_label" "$form_url"
agent-browser --session "$session" --cdp 9222 --pin-tab \
    wait --load networkidle

printf '%s\n' 'Form structure:'
agent-browser --session "$session" --cdp 9222 --pin-tab snapshot -i

# Use fresh refs from the snapshot above. Examples:
#
# agent-browser --session "$session" --cdp 9222 --pin-tab \
#     fill @e1 "Test User"
# agent-browser --session "$session" --cdp 9222 --pin-tab \
#     fill @e2 "user@example.com"
# agent-browser --session "$session" --cdp 9222 --pin-tab \
#     select @e3 "Option Value"
# agent-browser --session "$session" --cdp 9222 --pin-tab \
#     check @e4
# agent-browser --session "$session" --cdp 9222 --pin-tab \
#     upload @e5 /path/to/file.pdf
#
# Obtain confirmation immediately before a consequential submission:
#
# agent-browser --session "$session" --cdp 9222 --pin-tab click @e6
# agent-browser --session "$session" --cdp 9222 --pin-tab \
#     wait --url "**/success"

printf '%s\n' 'Current result:'
agent-browser --session "$session" --cdp 9222 --pin-tab get url
agent-browser --session "$session" --cdp 9222 --pin-tab snapshot -i
agent-browser --session "$session" --cdp 9222 --pin-tab \
    screenshot /tmp/form-result.png

printf '%s\n' 'Screenshot: /tmp/form-result.png'
printf '%s\n' 'The task tab remains open.'
