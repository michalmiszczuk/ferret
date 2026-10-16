# review-app — Design Spec

**Date:** 2026-10-15
**Status:** Draft for review
**Owner:** Michał Miszczuk

## 1. Purpose

AI code reviews (starting with Claude Code) come back as plain text. That is fine to read once, but hard to act on.
`review-app` is a **personal, local triage desk** for AI review findings:

- See every finding in one list, sorted by severity (🔴 Critical → 🟢 Low).
- Click a finding to see the actual code with the comment shown inline at the flagged lines.
- Decide per finding: **fix**, **dismiss**, or change severity.
- Send the fix decisions back to **Claude Code in VS Code**, which makes the code changes and reports back. The app shows the progress live.

### Success criteria

1. After `/ai-review` in Claude Code, the findings appear in the app with no copy-paste.
2. Clicking a finding shows the code at the right lines with the comment inline.
3. Marking findings "Fix" and pasting one short prompt into Claude makes Claude fix exactly those findings, honoring any per-finding note.
4. Each finding's status updates in the app (fixing → fixed/skipped) without a page reload.

### Non-goals (v1)

- Collaboration, sharing, multiple users.
- GitHub / Bitbucket PR integration (planned for a later phase; the data model must not block it).
- Editing code inside the app. Claude or the user in VS Code edits code.
- Light theme. The app is dark mode only.
- Pushing messages into the Claude chat automatically (v1 uses a clipboard prompt).
- AI agents other than Claude.

## 2. Architecture

A single local Node.js + TypeScript process, `review-app`, listening on `127.0.0.1:4477`.

```
 Claude Code (VS Code) ──MCP (Streamable HTTP)──┐
                                                 ▼
                                  ┌──────────────────────────┐
                                  │     review-app server     │──reads files──▶ repo on disk
                                  │   /mcp    /api    /       │
                                  └──────────────────────────┘
                                                 │ Server-Sent Events
                                                 ▼
                                  Browser UI ──"Open in VS Code"──▶ vscode://file/<abs>:<line>
```

| Part | Responsibility |
|---|---|
| `/mcp` | MCP server (official `@modelcontextprotocol/sdk`, Streamable HTTP transport). Exposes the three tools in §4. |
| `/api` | REST + SSE for the UI: list reviews, get a review, update a finding, read a file, subscribe to changes. |
| `/` | Static React UI built with Vite. |
| Store | One JSON file per review in `~/.review-app/reviews/<reviewId>.json`. Nothing is written inside the user's repos. |

Claude Code registration (one time):

```
claude mcp add --transport http --scope user review-app http://127.0.0.1:4477/mcp
```

### Module boundaries

- `server/store` loads and saves reviews and emits change events. It knows nothing about HTTP or MCP.
- `server/mcp` holds the MCP tool definitions. It calls the store only.
- `server/api` holds the REST/SSE handlers. It calls the store and `server/files`.
- `server/files` does safe file reads within a `repoRoot`, git diff line info, and snippet re-anchoring.
- `shared/schema` holds the Zod schemas and TS types used by server, MCP, and UI.
- `ui/` holds the React app. It talks to `/api` only.

## 3. Data model

Defined once in `shared/schema` with Zod. TS types are inferred from it.

```ts
type Severity = "critical" | "high" | "medium" | "low";

type FindingStatus =
  | "open"           // not decided yet
  | "fix_requested"  // user clicked Fix; waiting for Claude
  | "fixing"         // Claude pulled it via get_pending_actions
  | "fixed"          // Claude reported done
  | "skipped"        // Claude reported it did not fix it (with note)
  | "dismissed";     // user decided not to act

interface Review {
  id: string;                 // short id, e.g. "r_8f3k2a"
  createdAt: string;          // ISO timestamp
  repoRoot: string;           // absolute path
  scope: { kind: "diff"; target: "uncommitted" }
       | { kind: "files"; target: string[] };   // repo-relative files or folders
  summary: string;            // Claude's short overall verdict
  agent: "claude";            // room for other agents later
  findings: Finding[];
}

interface Finding {
  id: string;                 // unique within review, e.g. "f1"
  severity: Severity;         // user can override in the UI
  originalSeverity: Severity; // as assigned by Claude
  title: string;              // one line, shown in the list
  body: string;               // markdown: what is wrong, why, failure scenario
  suggestion?: string;        // proposed fix (prose or code)
  category: "bug" | "security" | "performance" | "maintainability" | "style" | "other";
  file: string;               // repo-relative, forward slashes
  lineStart: number;          // 1-based, inclusive
  lineEnd: number;            // 1-based, inclusive, >= lineStart
  snippet: string;            // exact code lines lineStart..lineEnd at review time
  status: FindingStatus;
  myNote?: string;            // user's instruction to Claude for this finding
  resolution?: string;        // Claude's note from mark_done
  updatedAt: string;
}
```

## 4. MCP tools

All inputs are validated with the Zod schemas. On a validation error the tool returns an MCP error with a precise message so Claude can correct and retry.

### `submit_review`

- **Input:** `{ repoRoot, scope, summary, findings: Array<{ severity, title, body, suggestion?, category, file, lineStart, lineEnd, snippet }> }`
- **Behavior:** assigns review and finding IDs, sets `status: "open"` and `originalSeverity = severity`, saves the review, and emits an SSE event.
- **Returns:** `{ reviewId, url: "http://127.0.0.1:4477/r/<reviewId>", counts: { critical, high, medium, low } }`

### `get_pending_actions`

- **Input:** `{ reviewId?: string }`. If omitted, the most recent review is used.
- **Behavior:** returns all findings with `status: "fix_requested"` and moves them to `"fixing"`.
- **Returns:** `{ reviewId, repoRoot, actions: Array<{ findingId, severity, title, body, suggestion?, file, lineStart, lineEnd, snippet, myNote? }> }`. The file and lines are re-anchored to the current file contents (§6) when possible.

### `mark_done`

- **Input:** `{ reviewId, findingId, outcome: "fixed" | "skipped", note: string }`
- **Behavior:** sets `status` to `outcome`, `resolution` to `note`, and emits an SSE event.
- **Returns:** `{ ok: true, remaining: number }`, the count of findings still `fixing` in that review.

## 5. Claude Code skills

Installed to `~/.claude/skills/` by a setup command (`npx review-app setup`, which also runs the `claude mcp add` registration).

### `/ai-review [paths...]`

Named `ai-review` (not `review`) because Claude Code already has a built-in `/review` command.

- No arguments: reviews uncommitted changes (`git diff HEAD` plus untracked files).
- With paths: reviews those whole files or folders.
- Instructs Claude to:
  1. Gather the code in scope.
  2. Review for bugs, security, performance, and maintainability. Prefer fewer, well-grounded findings over many weak ones.
  3. Rate severity with these rules:
     - **critical**: security vulnerability, data loss/corruption, crash on a main path.
     - **high**: likely bug, broken edge case, race condition.
     - **medium**: risky pattern, weak error handling, maintainability problem.
     - **low**: naming, style, small cleanups.
  4. Give exact `lineStart`/`lineEnd` and copy the exact `snippet` for those lines.
  5. Call `submit_review`, then reply with **one line**: counts per severity plus the URL. It must not repeat the findings as text.

### `/apply-review [reviewId]`

- Calls `get_pending_actions`.
- For each action: applies the fix (honoring `myNote`), then calls `mark_done` with `fixed` or `skipped` and a one-sentence note.
- Ends with a short summary.

## 6. Code display and re-anchoring

- The UI requests `GET /api/reviews/:id/file?path=<repo-relative>`. The server returns the **current** file contents plus the line numbers changed versus `HEAD` (from `git diff`, or none if the path is not a git repo).
- **Re-anchoring:** if lines `lineStart..lineEnd` of the current file no longer equal `snippet` (whitespace-trimmed comparison per line), the server searches the file for the snippet:
  - Exactly one match: use the new line range.
  - Several matches: use the one nearest the original `lineStart`.
  - No match: flag `anchor: "lost"`. The UI shows "⚠ code changed since review" with the original snippet.
- File missing: the response is `{ exists: false }`. The UI shows the original snippet with "file no longer exists".

## 7. UI

Dark theme only. React + Vite. Code highlighting with Shiki (read-only).

### Layout

- **Header:** review title (scope + repo name + time), severity counts, review switcher, and the **"Send N to Claude"** button (N = number of `fix_requested`).
- **Left pane (findings list):**
  - Sorted by severity (critical → low), then file, then line.
  - Each row has a severity color marker, title, and `file:line`.
  - Filters: severity (multi-select) and status (Open / All / Done).
  - `fixed`, `skipped` and `dismissed` go into a collapsed "Done" group at the bottom.
- **Right pane (code + comment):**
  - The whole file with syntax highlighting, scrolled to the selected finding, with its lines highlighted in the severity color.
  - The comment card is rendered **inline directly below the flagged lines**. It shows severity, category, title, body (markdown), suggestion, the "Note to Claude" text field, the actions Fix / Dismiss / Severity, and "Reset to open" when `fixing`/`skipped`/`dismissed`.
  - Gutter: marks for lines changed vs `HEAD`, and colored dots for the other findings in the same file (click a dot to select that finding).
  - **Open in VS Code** links to `vscode://file/<absolute path>:<line>`.

### Keyboard

`j`/`k` next/previous finding · `f` mark Fix · `d` dismiss · `n` focus the note field · `Esc` leave the note field.

### "Send to Claude"

Copies `/apply-review <reviewId>` to the clipboard and shows a toast: "Copied, paste into Claude in VS Code". Status changes then arrive live through SSE.

## 8. Error handling

| Situation | Behavior |
|---|---|
| Server not running when Claude calls a tool | The MCP call fails. The skills tell Claude to ask the user to start `review-app` and then retry. The findings stay in Claude's context. |
| Invalid tool input | Zod error message returned to Claude, which retries. |
| Path outside `repoRoot` (`..`, absolute paths, symlink escape) | Rejected with 400. Paths are resolved with `realpath` and checked to be inside `realpath(repoRoot)`. |
| Corrupt review JSON on disk | That review is skipped in the list with a logged warning. The others still load. |
| Finding stuck in `fixing` | The user clicks "Reset to open". |
| Browser closed or reopened | All state comes from disk, so nothing is lost. |

The server binds to `127.0.0.1` only and rejects (403) any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS-rebinding attacks from web pages open in the browser.

## 9. Testing

- **Unit (Vitest):** Zod schemas, sorting/filtering, re-anchoring (exact / moved / multiple / lost), the path-safety check, and store load/save.
- **MCP integration:** start the server on a random port and use an MCP client to run `submit_review` → set a finding to `fix_requested` via `/api` → `get_pending_actions` → `mark_done`, asserting the state after each step.
- **UI:** component tests (Vitest + Testing Library) for the findings list ordering and filters and for the comment card actions.
- **Manual E2E:** in a sample repo, run `/ai-review`, triage in the app, run `/apply-review`, and watch the statuses update live.

## 10. Project layout

```
review-app/
  package.json            # single package, bin: review-app
  src/
    shared/schema.ts
    server/
      index.ts            # http server: /mcp, /api, static UI
      store.ts
      files.ts            # safe read, git diff lines, re-anchor
      mcp.ts
      api.ts
    cli/
      index.ts            # `review-app` (start) and `review-app setup`
    ui/                   # Vite + React app
  skills/
    ai-review/SKILL.md
    apply-review/SKILL.md
  tests/
```

## 11. Future phases (not in v1)

- GitHub / Bitbucket PRs: review the PR diff, plus a "Post as PR comment" action per finding.
- Auto-push of decisions into the Claude session (no clipboard step).
- Auto-start of the server from Claude Code.
- A VS Code extension reusing the same server, with inline editor comments.
- Other AI agents as review sources.
