#!/usr/bin/env bash
set -euo pipefail

: "${PI_SESSION_ID:?PI_SESSION_ID is required}"

target_url="${1:?Usage: $0 <url> [output-dir]}"
output_dir="${2:-.}"
session="pi-${PI_SESSION_ID}"
tab_label="capture-$$"

mkdir -p "$output_dir"

agent-browser --session "$session" --cdp 9222 --pin-tab \
    tab new --label "$tab_label" "$target_url"
agent-browser --session "$session" --cdp 9222 --pin-tab \
    wait --load networkidle

title="$(
    agent-browser --session "$session" --cdp 9222 --pin-tab get title
)"
final_url="$(
    agent-browser --session "$session" --cdp 9222 --pin-tab get url
)"

agent-browser --session "$session" --cdp 9222 --pin-tab \
    screenshot --full "$output_dir/page-full.png"
agent-browser --session "$session" --cdp 9222 --pin-tab \
    snapshot -i >"$output_dir/page-structure.txt"
agent-browser --session "$session" --cdp 9222 --pin-tab \
    get text body >"$output_dir/page-text.txt"
agent-browser --session "$session" --cdp 9222 --pin-tab \
    pdf "$output_dir/page.pdf"

printf 'Title: %s\n' "$title"
printf 'URL: %s\n' "$final_url"
printf 'Saved captures under: %s\n' "$output_dir"
printf 'The task tab remains open.\n'
