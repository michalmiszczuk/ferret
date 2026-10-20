---
name: ai-review
description: Review code — uncommitted changes, specific files/folders, a commit, a range (HEAD~3..HEAD), a branch, or a pull request (#218 or URL) — and send structured findings to Ferret (review-app) for triage. Use when the user runs /ai-review or asks to review code "into Ferret".
---

# AI review → Ferret (review-app)

You are reviewing code and delivering the result to **Ferret** (MCP server `review-app`, tools `prepare_review_scope` and `submit_review`). The user reads and triages findings in the app, NOT in this chat. Do not modify any code during a review.

## 1. Scope

Find the repo root: `git rev-parse --show-toplevel` (if not a git repo, use the current working directory). On Windows give a native path such as `C:/Users/me/project` (in Git Bash use `pwd -W`, not `pwd`, which prints `/c/...`). Call it `<repo>`.

Decide the scope from the argument after `/ai-review`:

| Argument | What to do |
|---|---|
| nothing | `prepare_review_scope({ repo: "<repo>", scope: "changes" })` — uncommitted changes. If it returns no changed files, tell the user and stop. |
| file or folder paths (e.g. `src/auth/`) | **No tool call.** Review those files/folders completely (recurse into folders; skip `node_modules`, `dist`, `build`, lock files, generated and binary files). `repoRoot` = `<repo>`, submit scope `{ "kind": "files", "target": [<paths as given>] }`, no `scopeId`. |
| `a..b` (e.g. `HEAD~3..HEAD`, `main..feature/x`) | `prepare_review_scope({ repo, scope: { range: "a..b" } })` |
| a commit (`3f2a1c9`, `HEAD~1`) | `prepare_review_scope({ repo, scope: { commit: "<it>" } })` |
| `#218`, `218`, or a PR URL | `prepare_review_scope({ repo, scope: { pr: "<it>" } })` |
| a branch name (`feature/x`) | `prepare_review_scope({ repo, scope: { branch: "<it>" } })` — compared with the default branch |

**Handing the review to Ferret instead.** If the user asks Ferret to do the review ("let Ferret review it", "send it to Ferret", `/ai-review … in ferret`), don't review in this chat. Call `start_review({ repo, scope, notes, task? })` with the same `scope` as in the table, and put in `notes` what this conversation knows that the diff doesn't: what the change is for, decisions already made and why, what the user is worried about, what to ignore. A few short paragraphs, facts only. Pass `task` if the user gave a ClickUp task link. Then reply with one line saying the review is queued in Ferret, and stop.

`prepare_review_scope` fetches and snapshots as needed and returns `checkout` (where the code is), `isWorktree`, `diffCommand`, `changedFiles`, `label` and a `scopeId`.

- **Read the code in `checkout`**, not in `<repo>`: for a PR or an older commit it is a detached snapshot (another folder). Run git there as `git -C "<checkout>" …`, e.g. the returned `diffCommand`.
- Read whole files for context, not just diff hunks. Report issues in the changed code or issues the change causes.
- In `submit_review`, pass `repoRoot: "<checkout>"`, `scope: { "kind": "files", "target": <changedFiles> }`, and the `scopeId`. Finding `file` paths are relative to `checkout`, forward slashes.

## 2. What to look for

Bugs, security problems, performance issues, and maintainability problems. Only report issues you can point to concrete lines. Prefer fewer, well-grounded findings over many weak ones (at most ~25).

## 3. Severity rules (use exactly these values)

- `critical`: security vulnerability, data loss/corruption, crash on a main path.
- `high`: likely bug, broken edge case, race condition.
- `medium`: risky pattern, weak error handling, maintainability problem.
- `low`: naming, style, small cleanups.

## 4. Each finding

- `title`: one line, states the problem ("Expired sessions are still accepted").
- `body`: markdown. What is wrong, why it matters, and a concrete failure scenario (inputs/state → wrong result).
- `suggestion` (optional): the fix, in words or a short code block.
- `category`: `bug | security | performance | maintainability | style | other`.
- `file`: repo-relative, forward slashes.
- `lineStart`/`lineEnd`: 1-based line numbers in the file **as it is now on disk**.
- `snippet`: the exact text of lines `lineStart..lineEnd`, copied from the file without line-number prefixes. This is used to re-find the lines if the file changes, so it must match.
- `steps` (optional): **add steps whenever understanding the problem means visiting more than one place** — data flowing from where it enters to where it does damage, a caller and the callee it misuses, config and its usage, a cache and the reset that misses it. Before submitting a `high` or `critical` finding, ask yourself where the bad value comes from and where it bites; if those are different lines, write the path. An ordered list of 2–10 points, each with `file`, `lineStart`, `lineEnd`, `snippet` (same rules as above) and a one-line `note` saying what happens there (e.g. "text comes from the third-party node definition", "passed through unchanged", "rendered as HTML: this is where it bites"). Include the finding's main location as one of the steps. Leave `steps` out only when the finding truly lives on one spot.

## 5. Submit

Call `submit_review` with `repoRoot`, `scope`, the `scopeId` from `prepare_review_scope` (when you called it), a one-paragraph `summary`, all `findings`, `sessionId: "${CLAUDE_SESSION_ID}"` and `projectDir: "${CLAUDE_PROJECT_DIR}"` (this session's id and folder, so the app's "Send to Claude" can come back to this conversation in the right VS Code window).

- If the tool returns a validation error, fix the offending fields and call it again.
- If the `review-app` tool is unavailable or the connection fails, the app is probably not running:
  1. Launch it. Windows (PowerShell): `Start-Process review-app://open`. Windows (Git Bash): `cmd //c start "" review-app://open`. macOS: `open review-app://open`.
  2. Wait about 5 seconds, then call `submit_review` once more.
  3. If it still fails, tell the user: "review-app is starting but Claude Code isn't connected to it yet. Run `/mcp`, reconnect `review-app`, then tell me to retry." If launching failed because the app isn't installed, say: "Start review-app (desktop app, or `review-app` in a terminal), then tell me to retry." Keep the findings and resubmit when asked.

## 6. Reply

Reply with ONE line only, using the counts and url from the tool result:

`Review r_xxxxxx: 🔴 2 · 🟠 3 · 🟡 4 · 🟢 3 → http://127.0.0.1:4477/r/r_xxxxxx`

Do not list or repeat the findings in chat.
