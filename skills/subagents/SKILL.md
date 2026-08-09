---
name: subagents
description: Run and supervise a separate interactive Pi agent through a persistent PTY. Use when the user asks for a subagent or when an independent worker should handle a bounded task.
---

# Subagents

Treat the child as a supervised collaborator. Keep ownership of the parent task, give the child one bounded objective, and verify its result yourself.

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

## 2. Open Pi in a PTY

Use `shell_open` with an explicit regular TUI, the target working directory, and PTY mode:

```text
shell_open({
  cmd: "pi --tui-mode regular",
  cwd: "<target working directory>",
  pty: true,
  yield_after: 1
})
```

`--tui-mode regular` overrides a fullscreen setting. Preserve the returned resource ID for every later operation.

Take a `shell_snapshot` before sending the task. Resolve any startup prompt only from facts already established by the parent; use `--approve` at launch only when the target project is already trusted for this run.

**Complete when:** the snapshot shows Pi ready for input and the PTY resource ID is known.

## 3. Submit and converse

Send the delegation with `shell_write`. Pi's interactive editor requires a carriage return to activate Enter:

```text
shell_write({ resource_id: "<id>", text: "<delegation prompt>\r" })
```

The trailing `\r` is mandatory. `\n` is not a substitute and may leave the message unsubmitted. `shell_write` sends text verbatim and appends nothing automatically.

Use the same pattern for every correction, question, or steering message:

```text
shell_write({ resource_id: "<id>", text: "<follow-up>\r" })
```

When Pi is working, submitted text may queue as steering for the next turn. Write a precise follow-up rather than restarting the child.

**Complete when:** a snapshot shows the task in the child transcript or queued in its editor.

## 4. Supervise the run

Alternate the observation tools deliberately:

- Use `shell_wait` with a bounded `yield_after` to give the child time to work and receive the latest visible terminal. A yielded wait means Pi is still running; continue supervision.
- Use `shell_snapshot` to inspect immediately. Request a small trailing `lines` count for routine checks and a complete snapshot when context is missing.
- Compare snapshot revisions and visible activity to distinguish progress from an unchanged screen.

Read what the child is doing: tool calls, questions, errors, and claims. Answer questions with `shell_write`, redirect scope drift, and ask for missing evidence or tests. Continue until `SUBAGENT_DONE` is visible and the response satisfies every requested output.

If the marker appears without an adequate result, explain the gap in a follow-up and continue the same conversation.

**Complete when:** the child's final result is captured, internally consistent, and supported by the requested evidence or verification.

## 5. Harvest, stop, and verify

Record the result and any changed paths before closing the child. At an idle Pi prompt, shut it down cleanly:

```text
shell_write({ resource_id: "<id>", text: "/quit\r" })
shell_wait({ resource_id: "<id>", yield_after: 10 })
```

Confirm that the resource completed. Then independently inspect cited files, diffs, and test results in the parent session. Treat the child's conclusions as evidence, not authority, and integrate only what survives verification.

**Complete when:** the child process is closed, its useful result has been incorporated, and every delegated claim that affects the parent answer has been checked.
