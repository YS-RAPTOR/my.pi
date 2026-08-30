---
name: web-search
description: Search the public web with Google in the shared Vivaldi browser and answer with source links. Use when the user asks to search the web, find current information or sources, compare online claims, or verify a fact that requires web results.
available-if: |
  command -v agent-browser >/dev/null 2>&1 &&
  command -v curl >/dev/null 2>&1 &&
  command -v jq >/dev/null 2>&1 &&
  curl --fail --silent --max-time 1 --output /dev/null \
    http://127.0.0.1:9222/json/version &&
  printf true
allowed-tools: Bash(agent-browser:*) Bash(curl:*) Bash(jq:*)
---

# Web search

Search with Google, inspect a compact result set, then read only the sources needed to answer.

## 1. Establish browser ownership

Read [browser-use](../browser-use/SKILL.md) and follow its Pi session, CDP, task-tab, trust-boundary, and completion rules.

Create or reuse one task-owned search tab before submitting a query.

**Complete when:** the Pi session is pinned to the deliberate search tab.

## 2. Form one query

Start with the narrowest query that still expresses the user's question. Preserve exact names, versions, dates, error messages, and quoted phrases. Add `site:`, `after:`, exclusions, or another operator only when it removes a known ambiguity.

The query is sent to Google. Avoid adding private context that is unnecessary for the search.

**Complete when:** one query represents the information needed for the next decision.

## 3. Open web-only results

Encode the query and navigate directly to Google's web-results mode:

```bash
QUERY='agent-browser CLI'
ENCODED_QUERY="$(jq -rn --arg query "$QUERY" '$query | @uri')"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  open "https://www.google.com/search?q=${ENCODED_QUERY}&udm=14&hl=en&num=10"
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  wait "#search"
```

If `#search` does not appear, take one interactive snapshot. Let the user handle CAPTCHA, account, or consent challenges in visible Vivaldi; do not attempt to bypass them.

**Complete when:** Google shows the requested web results or a user-actionable challenge is identified.

## 4. Extract compact results

Use structured DOM extraction instead of loading Google's full accessibility tree:

```bash
cat <<'EOF' | agent-browser \
  --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab eval --stdin
const results = [];
const seen = new Set();
for (const heading of document.querySelectorAll("#search h3")) {
  const link = heading.closest("a");
  if (!link?.href || seen.has(link.href)) continue;
  const url = new URL(link.href, location.href);
  if (/^(www\.)?google(adservices)?\.com$/.test(url.hostname)) continue;
  seen.add(link.href);
  const result = heading.closest(".MjjYud, .g");
  const snippet = result?.querySelector(".VwiC3b, [data-sncf]");
  results.push({
    title: heading.innerText.trim(),
    url: link.href,
    snippet: (snippet?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 320),
  });
  if (results.length === 8) break;
}
results;
EOF
```

If Google's DOM changes and extraction returns nothing, fall back once:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  snapshot -i -u -c -d 3 -s "#search"
```

Treat rankings and snippets as discovery hints, not verified evidence.

**Complete when:** up to eight relevant titles and destination URLs are available.

## 5. Read the evidence

Choose the smallest credible source set that can answer the question—normally two to four pages. Prefer primary sources, current documentation, official announcements, standards, papers, and direct reporting over aggregators.

Read a source directly:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  read "https://example.com/relevant-page"
```

For long pages, inspect the outline or request one matching section:

```bash
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  read "https://example.com/relevant-page" --outline
agent-browser --session "pi-${PI_SESSION_ID}" --cdp 9222 --pin-tab \
  read "https://example.com/relevant-page" --filter "relevant heading"
```

Use the rendered task tab only when direct reading misses JavaScript-rendered or visually necessary content. Search snippets alone do not substantiate a claim.

**Complete when:** every material claim has support from a page that was actually read.

## 6. Refine only on evidence gaps

Run another Google query only when the first result set is ambiguous, stale, contradictory, or missing a required perspective. Change one constraint at a time so each refinement has a purpose.

Stop when additional searching would only repeat the same evidence.

**Complete when:** the evidence resolves the user's question or the remaining uncertainty is explicit.

## 7. Answer

Lead with the answer, then give the minimum supporting detail. Link citations to the exact pages read, placing each link beside the claim it supports. Distinguish sourced fact, inference, and unresolved disagreement.

Mention search limitations only when they affect confidence. Follow browser-use's finish procedure for the task tab.

**Complete when:** the response answers the question concisely and every substantive web claim has a source link.

## Token discipline

- Extract at most eight Google results.
- Read two to four sources unless the task demands broader coverage.
- Prefer `read --filter` over loading an entire long page.
- Use snapshots only for interaction or extraction fallback.
- Use screenshots only when visual evidence matters.
- Keep one search tab and refine sequentially rather than opening result tabs in bulk.
