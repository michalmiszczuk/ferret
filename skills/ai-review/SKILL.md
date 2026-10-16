---
name: ai-review
description: Review local code — uncommitted changes, or specific files/folders — and send structured findings to review-app for triage. Use when the user runs /ai-review or asks to review code "into review-app".
---

# AI review → review-app

You are reviewing code and delivering the result to **review-app** (MCP server `review-app`, tool `submit_review`). The user reads and triages findings in the app, NOT in this chat. Do not modify any code during a review.

## 1. Scope

- Find the repo root: `git rev-parse --show-toplevel` (if not a git repo, use the current working directory). Use the absolute path as `repoRoot`. On Windows give a native path such as `C:/Users/me/project` (in Git Bash use `pwd -W`, not `pwd`, which prints `/c/...`).
- **No paths given after /ai-review:** review uncommitted changes. Get them with `git diff HEAD` and `git ls-files --others --exclude-standard`. Scope = `{ "kind": "diff", "target": "uncommitted" }`. If there are no changes, tell the user and stop.
- **Paths given:** review those files/folders completely (recurse into folders; skip `node_modules`, `dist`, `build`, lock files, generated and binary files). Scope = `{ "kind": "files", "target": [<paths as given>] }`.
- Read whole files for context, not just diff hunks. For a diff review, report issues in the changed code or issues the change causes.

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

## 5. Submit

Call `submit_review` with `repoRoot`, `scope`, a one-paragraph `summary`, all `findings`, `sessionId: "${CLAUDE_SESSION_ID}"` and `projectDir: "${CLAUDE_PROJECT_DIR}"` (this session's id and folder, so the app's "Send to Claude" can come back to this conversation in the right VS Code window).

- If the tool returns a validation error, fix the offending fields and call it again.
- If the `review-app` tool is unavailable or the connection fails, the app is probably not running:
  1. Launch it. Windows (PowerShell): `Start-Process review-app://open`. Windows (Git Bash): `cmd //c start "" review-app://open`. macOS: `open review-app://open`.
  2. Wait about 5 seconds, then call `submit_review` once more.
  3. If it still fails, tell the user: "review-app is starting but Claude Code isn't connected to it yet. Run `/mcp`, reconnect `review-app`, then tell me to retry." If launching failed because the app isn't installed, say: "Start review-app (desktop app, or `review-app` in a terminal), then tell me to retry." Keep the findings and resubmit when asked.

## 6. Reply

Reply with ONE line only, using the counts and url from the tool result:

`Review r_xxxxxx: 🔴 2 · 🟠 3 · 🟡 4 · 🟢 3 → http://127.0.0.1:4477/r/r_xxxxxx`

Do not list or repeat the findings in chat.
