---
name: subagents
description: Run and supervise a separate interactive Pi agent through a persistent PTY. Use when the user asks for a subagent or when an independent worker should handle a bounded task.
available-if: |
  command -v tmux >/dev/null 2>&1 &&
  command -v pi >/dev/null 2>&1 &&
  command -v bash >/dev/null 2>&1 &&
  printf true
---

# Subagents

Treat the child as a supervised collaborator. Keep ownership of the parent task, give the child one bounded objective, and verify its result yourself.

Read the [interactive shell skill](../automation/interactive-shell/SKILL.md) and its interaction, output, and lifecycle references before starting. Its private tmux resource is the transport and the source of truth for opening, input, observation, status, waiting, termination, and cleanup. This skill adds only Pi-specific supervision.

## 1. Frame the delegation

Write a self-contained prompt with:

- the objective and why it matters;
- the working directory and relevant context;
- explicit scope and ownership boundaries;
- the evidence, edits, tests, or recommendation expected;
- a request to report blockers instead of guessing;
- `Finish your final response with SUBAGENT_DONE.`

Tell the child to perform the task directly; nested delegation is out of scope. Prefer investigation or review in a shared working tree. Assign edits only when the child's file ownership cannot conflict with your own work.

**Complete when:** the child can perform the task without access to the parent conversation or an unstated decision.

## 2. Open Pi

Apply the interactive shell's open workflow with:

```bash
SOCKET="pi-shell-${PI_SESSION_ID}"
RESOURCE="subagent-$(date +%s)-${RANDOM}"
CWD="/absolute/target/working/directory"
COMMAND='pi --tui-mode regular'
```

`--tui-mode regular` keeps captures readable. Use `--approve` only when the target project is already trusted for this run. Record the concrete `SOCKET`, `RESOURCE`, and `PANE`; re-declare them at the start of every later Bash call.

Capture the pane and inspect fresh status before sending the task. Resolve any startup prompt only from facts already established by the parent.

**Complete when:** a pane capture shows Pi ready for input and the tmux resource values are recorded.

## 3. Submit and converse

Paste a multiline delegation through a tmux buffer, then send Enter as a named key:

```bash
printf '%s' "$DELEGATION" | tmux -L "$SOCKET" load-buffer -
tmux -L "$SOCKET" paste-buffer -d -t "$PANE"
tmux -L "$SOCKET" send-keys -t "$PANE" Enter
```

For a one-line correction, question, or steering message:

```bash
tmux -L "$SOCKET" send-keys -l -t "$PANE" -- 'follow-up'
tmux -L "$SOCKET" send-keys -t "$PANE" Enter
```

Literal input appends nothing; the separate `Enter` submits it. When Pi is working, submitted text may queue as steering for the next turn. Write a precise follow-up rather than restarting the child.

Capture the pane after submission.

**Complete when:** the pane shows the task in the child transcript or queued in its editor.

## 4. Supervise the run

Use the interactive shell's bounded capture, status, and wait operations deliberately:

- Capture the visible pane for routine checks.
- Capture a bounded history page when the needed context has scrolled away.
- Poll with a deadline to give the child time to work. A live pane at the deadline means Pi is still running, not that it failed.
- Compare successive captures to distinguish progress from an unchanged screen.

Read what the child is doing: tool calls, questions, errors, and claims. Answer questions through literal tmux input, redirect scope drift, and ask for missing evidence or tests. Continue until `SUBAGENT_DONE` is visible and the response satisfies every requested output.

If the marker appears without an adequate result, explain the gap in a follow-up and continue the same conversation.

**Complete when:** the child's final result is captured, internally consistent, and supported by the requested evidence or verification.

## 5. Harvest, stop, and verify

Record the result and any changed paths before closing the child. At an idle Pi prompt, shut it down cleanly:

```bash
tmux -L "$SOCKET" send-keys -l -t "$PANE" -- '/quit'
tmux -L "$SOCKET" send-keys -t "$PANE" Enter
```

Wait with a deadline and confirm that the pane completed. If clean exit fails, use the interactive shell's graceful-to-force lifecycle. Capture final output and exit state before removing the tmux session.

Then independently inspect cited files, diffs, and test results in the parent session. Treat the child's conclusions as evidence, not authority, and integrate only what survives verification.

**Complete when:** the child process is closed, its useful result has been incorporated, and every delegated claim that affects the parent answer has been checked.
