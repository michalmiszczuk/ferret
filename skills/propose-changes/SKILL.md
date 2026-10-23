---
name: propose-changes
description: Propose a code change as ordered steps the user approves one by one in Ferret (review-app) before anything is edited. Use when the user runs /propose-changes, says "propose this in Ferret", "step by step in Ferret", or wants to approve each edit before it happens.
---

# Propose changes → Ferret (review-app)

You are about to change code, but the user wants to **approve each step in Ferret first**. You describe the change as steps with the `review-app` MCP tool `propose_changes`; the user accepts, asks about or declines each step in the app; their decisions come back to this chat as `/apply-proposal …` messages (handled by the `apply-proposal` skill). **Edit nothing until a step is accepted.**

## 1. Understand the task

The argument after `/propose-changes` (or the conversation) says what to build or fix. Work it out as you normally would: find the repo root (`git rev-parse --show-toplevel`, native Windows path such as `C:/Users/me/project`), read the code, decide the change. **Read every file you will touch, in full**, before writing a step: `before` must be copied from what is actually there.

## 2. Write the steps

One concern per step, in the order they should be applied. Each step:

| Field | Rule |
|---|---|
| `stepId` | Short and unique in the proposal: `s1`, `s2`, … or `rename-helper`. |
| `title` | One line, imperative: "Extract the retry loop into `withRetry`". |
| `kind` | `edit` (replace text in an existing file), `create` (new file), `delete` (remove text), `command` (run something, e.g. tests). |
| `file`, `lineStart`, `lineEnd` | Repo-relative path with forward slashes; the lines where `before` sits **now**. |
| `what` / `why` | One or two sentences each. `why` says what breaks or improves, not "as requested". |
| `before` | **The exact current text** that will be replaced, copied verbatim (indentation, blank lines, trailing commas). Ferret marks the step stale when the file no longer contains it, so never retype it from memory. Keep it to the lines that change plus the little context needed to be unique. |
| `after` | The full replacement for `before` (for `create`: the whole file). |
| `command` | For `kind: "command"`: the command to run, e.g. `npm test`. |
| `dependsOn` | Step ids that must be applied first (a step that uses a helper another step creates). Ferret blocks the step until they are applied. |
| `notes` | Inline explanations shown **inside the diff**, under the line they refer to: `[{ at, text }]`, where `at` is a distinctive part of one line of `after` (e.g. `export function selectTheme(`) and `text` one or two sentences on what that function/block does and why it is shaped that way. Add one for **every function, method, class or non-obvious block** in `after` (a reader should understand the algorithm without scrolling back to `what`); skip trivial lines (imports, one-line wrappers). |

Rules of thumb: at most ~15 steps (split a bigger task into two proposals); one file region per step (a change in two places is two steps, linked with `dependsOn` if the order matters); put a `command` step (typecheck, tests) after the edits it verifies; no step for things you would not do anyway.

## 3. Submit

Call `propose_changes` with:

- `repoRoot`: the repo's absolute path,
- `sessionId`: this session's id (`${CLAUDE_SESSION_ID}`), `projectDir`: this session's folder (`${CLAUDE_PROJECT_DIR}`) — this is how Ferret sends decisions back **here**,
- `task`: `{ title, context, planRef? }` — `context` is a short paragraph: the goal, constraints, the plan or ticket it comes from,
- `steps`.

If the `review-app` tool is unavailable or the connection fails, the app is probably not running. Launch it (Windows PowerShell: `Start-Process review-app://open`; Windows Git Bash: `cmd //c start "" review-app://open`; macOS: `open review-app://open`), wait about 5 seconds and call it once more. If it still fails, tell the user to run `/mcp`, reconnect `review-app`, and tell you to retry.

Reply with **one line**: `Proposal <proposalId>: <N> steps → <url>`, plus, the first time in a session, this note: *each accepted edit will still prompt here unless this session auto-accepts edits; switch to auto-accept edits for the proposal if you want one approval per step.* Then **stop and wait**. Do not apply anything, do not summarize the steps (the user reads them in Ferret).

## 4. While waiting

Decisions arrive as chat messages `/apply-proposal <proposalId> <stepId> accept|decline|ask [text]` or `/apply-proposal <proposalId> accept-all`: follow the `apply-proposal` skill for each. If you think a message was missed, call `get_proposal_decisions({ proposalId })`. New steps the user asks for go through `add_steps`; a step you want to rework goes through `revise_step` (the old version is kept; the user decides again).

Do not commit. The user reviews the changes and commits.
