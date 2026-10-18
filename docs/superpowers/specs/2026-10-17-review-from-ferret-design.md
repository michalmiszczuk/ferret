# Review from Ferret — Design Spec

**Date:** 2026-10-17
**Status:** Draft for review
**Owner:** Michał Miszczuk
**Builds on:** `2026-10-15-review-app-design.md` (v1 server/UI/MCP), `2026-10-16-desktop-app-design.md` (Electron shell). Repo name is still `review-app`; the product name is **Ferret**.

## 1. Intent

Today a review can only be started from a Claude Code chat (`/ai-review`), and only on local code. The user wants to start reviews **from Ferret itself**, on **pull requests, commits, commit ranges, or uncommitted changes**, for two jobs:

- **Own work before pushing:** review a commit or range, then fix things themselves (in VS Code, or "Send to Claude" as today).
- **Teammates' PRs:** review the PR, and for each finding worth raising, have Claude **draft a short review comment** for the author that the user edits and **copies** into GitHub/Bitbucket by hand.

The review itself and the drafts run **Claude Code in the background from Ferret**, with the user's existing Claude Code login. No chat window is needed to start or read a review.

### Goals

1. "Review ▶" in Ferret: pick a PR (paste link), a commit, a commit range, or uncommitted changes of a repo; findings arrive in Ferret like any other review. The same scopes work from the VS Code chat (`/ai-review HEAD~3..HEAD`, `/ai-review #218`).
1b. A review can be **shared as one Markdown file** that a friend reads anywhere and **imports into their Ferret**, opening at the same commit.
2. The user's own checkout is never modified by a review. PR branches are materialised in a hidden worktree owned by Ferret.
3. Per finding: **Draft reply** produces an editable, copyable comment for the PR author. **Draft all** does it for every open finding of a review.
4. Reviews show what was reviewed ("PR #218 · workflowbuilder · Sanitize RichText labels") and open code from the reviewed revision, with the changed lines marked.
5. Clear, actionable errors when a tool is missing or not logged in (`gh`, `git`, `claude`).

### Non-goals (this phase)

- Posting comments, approvals or "request changes" to GitHub/Bitbucket. Copy-paste only.
- Bitbucket API integration (see §4.2 for what Bitbucket users get now).
- An in-app Claude chat (planned next; this design must not block it, see §9).
- Reviewing from inside the VS Code chat is unchanged (`/ai-review` keeps working).
- Multi-user, sharing, light theme.

### Anti-goals

- A review that silently edits, checks out, stashes or fetches into the user's working copy. Any git write touches only Ferret's own worktrees under `~/.review-app`.
- Headless Claude being able to edit files or run arbitrary commands during a review. Reviews are read-only runs.

## 2. User experience

### 2.1 Starting a review

Header gets a primary **Review ▶** button (left of the review switcher). It opens a panel (modal) with three tabs:

| Tab | Input | Notes |
|---|---|---|
| **Pull request** | Paste a PR URL (`https://github.com/<owner>/<repo>/pull/<n>`), or pick a repo and choose from its open PRs (list via `gh pr list`, newest first, shows number · title · author · updated). | A Bitbucket PR URL is accepted and leads to the **branch** form: the user pastes the PR's source branch name (shown on the Bitbucket PR page); base branch defaults to the repo's default branch. |
| **Commit** | Pick a repo, then: **one commit** from the last 50 (`git log`: short hash · subject · author · relative date), or a **range** = "from this commit (exclusive) to that commit", or **branch vs base** (current branch against `main`/`master`/chosen). Pasting a hash or `a..b` is also allowed. | |
| **Changes** | Pick a repo: reviews uncommitted changes (staged + unstaged + untracked). | Same scope as `/ai-review` today. |

**Repo picker:** a dropdown of recent repos (from previous reviews' `repoRoot`s and previous jobs), plus **Browse…** (native folder dialog; the desktop app provides it, the terminal version shows a text field for a path). The chosen folder must be a git repo (has a `.git`); otherwise an inline error.

**PR URL → local clone.** Every PR review needs a local clone of that repo (the worktree is created from it). The PR tab therefore always has the repo picker; pasting a URL **auto-selects** the recent repo whose `origin` remote matches `owner/repo` (compared case-insensitively, `.git` suffix and `ssh`/`https` forms ignored). If none matches, the picker shows "Pick the local clone of owner/repo" and the user browses to it. Ferret never clones repos itself in this phase.

Pressing **Start review** closes the panel and shows a **job card** at the top of the findings list: spinner, "Fetching PR #218…" → "Reviewing 12 files…" → "Done: 🔴1 🟠2 🟡3 🟢1", elapsed time, a **Cancel** button, and on failure the error with a **Show log** disclosure (last 60 lines of Claude's output). When done, the new review opens (same rule as today: if another review is open the user gets the "New review arrived — Open it" toast).

Only **one review job runs at a time**; starting another queues it ("Queued, 1 ahead"). **Draft jobs run in their own lane** and are not blocked by a running review (they take seconds and only read files), but drafts for one review run sequentially.

### 2.2 Reading a PR/commit review

- Header line: `PR #218 · workflowbuilder · Sanitize RichText label HTML · by kuba` / `commit 3f2a1c9 · Fix sanitizer fail-open` / `main..feature/x · 4 commits` / `uncommitted changes`. The PR title links to the PR URL (opens the browser).
- The review switcher shows the same label.
- Code opens from the **reviewed revision**: for a PR, the worktree at the PR head; for a commit/range, the repo's own files **only if** HEAD is the reviewed head, otherwise a worktree at that head. Gutter "changed" marks come from the reviewed diff (base…head), not from `git diff HEAD`.
- **Open in VS Code** opens the file in the worktree for PRs (so the user sees the author's version); for own commits reviewed at HEAD it opens the user's checkout.
- **Send to Claude works on every review**, because the user talks to Claude about findings on teammates' PRs too ("explain step 3 thoroughly", "is this really reachable?"). Headless reviews have no Claude session, so Send opens VS Code on the review's **checkout folder** (`source.checkout`: the user's repo for own-work reviews, the Ferret worktree for PR/older-commit reviews) and a fresh Claude tab with `/apply-review …` pre-filled. `/apply-review` already handles questions (answers and marks the finding `skipped` with the answer as the note) and fixes. On a worktree review, any edits Claude makes land in the snapshot, never in the user's checkout; the card shows a hint "Snapshot of PR #218 — Claude's edits here don't touch your checkout; use Draft reply to tell the author". Each path step gets an **Ask about this step** link that opens the message box pre-filled with "About step 3 (<note>): " so questions about a specific point are one click away.

### 2.3 Draft reply

On every finding card (any review kind), a **Draft reply** button next to "Send to Claude". It runs Claude in the background (seconds) and fills an editable **Reply to author** box on the card with a comment in this shape: one sentence on what's wrong and why it matters, the location, and the suggested change (short code block when useful), tone friendly and direct, no greetings, max ~120 words. A **Copy** button copies it; a **Regenerate** button runs it again. The draft is stored on the finding (`draft`) and survives restarts.

**Draft all** (header, PR/commit reviews): drafts for every finding with status `open`, sequentially, with a small progress counter. Already-drafted findings are skipped unless the user chooses "Redo all".

### 2.4 Export, share and import (the portable review file)

Header **Export ▾** with **Copy Markdown** and **Save .md…** (desktop: native save dialog; terminal version: downloads the file). The document reads as a normal review write-up **and** is importable by another Ferret:

- Human part: a title line with the source label and PR link, the summary, then findings grouped by severity (🔴 → 🟢), each with title, `file:line`, category, the body, the suggestion, the path steps (numbered, with `file:line` and note), the user's **reply draft** if present (under "Reply"), and Claude's resolution if present. Dismissed findings go under a final "Dismissed" heading.
- Machine part: at the end, a fenced block ` ```json ferret-review ` holding `{ formatVersion: 1, review }` where `review` is the stored review **minus local paths**: `repoRoot`, `source.checkout`, `source.repo`, `sessionId`, `projectDir` are stripped; `source.repoName`, `source.head` (commit SHA), `source.base`, `source.url` and all findings (with snippets and steps) are kept. Status, notes and drafts are kept too.

**Import review** (header menu, or drop a `.md`/`.json` on the window): Ferret reads the block, asks for the local clone of `repoName` (auto-matched by `origin` like the PR tab), and then: if the clone has commit `source.head`, it creates a worktree at that commit so the importer sees exactly the reviewed code; otherwise it opens the review against the clone's current files and re-anchors by snippet (lines may show "code changed since review"). The imported review is marked `imported: true` and shows "Imported · reviewed by <name> at <date>" in the header. Without a clone, the user can still read the Markdown in any viewer; Ferret shows "Pick the local clone to see the code".

Pure functions (`exportReview(review) → string`, `parseExport(text) → review | error`), round-trip unit-tested. This is also the stepping stone for sending a review to ClickUp (§9).

### 2.6 Reviews started from the VS Code chat

`/ai-review` grows the same scopes as the panel: `/ai-review` (uncommitted), `/ai-review src/x/` (files), `/ai-review HEAD~3..HEAD` or `/ai-review <sha>` (commits), `/ai-review feature/x` (branch vs base), `/ai-review #218` or a PR URL (pull request). Instead of doing git plumbing itself, the skill calls a new MCP tool **`prepare_review_scope`** (§3.5) which runs the same scope engine as the panel: it fetches, creates the snapshot worktree when needed, computes the diff command, and returns where to read code and what to diff. Claude then reviews exactly as today and `submit_review` carries the returned `scopeId`, so the review gets its `source` label and the right checkout. Result: a review started from the chat and one started from Ferret are indistinguishable.

### 2.7 Errors the user will see

| Situation | Message |
|---|---|
| `gh` missing or not logged in | "GitHub CLI isn't available/logged in. Install it and run `gh auth login`, or review by branch instead." with a **Review by branch** shortcut. |
| `claude` not found on PATH | "Claude Code CLI not found. Ferret runs reviews with the `claude` command; install Claude Code or add it to PATH." |
| Claude exits non-zero / times out (15 min) | "Review failed: <first error line>" + Show log. |
| Claude finished but submitted nothing | "Claude found nothing to report." (an empty review is still created so the run is visible; the card shows 0 findings) |
| Folder is not a git repo; commit not found; fetch failed | Inline, specific messages ("Fetch failed: remote 'origin' not found"). |
| PR already reviewed (same head SHA) | Allowed, but the job card notes "Reviewed before: r_x (same commit)" with a link. |

## 3. Architecture

```
UI (Review panel, job card, Draft reply)
   │  REST + SSE (/api/jobs, /api/repos, /api/prs, /api/commits, job-updated events)
   ▼
server/jobs.ts ─── runs one job at a time ───► server/claude-runner.ts  (spawns `claude -p …`)
   │                                                   │
   ├─ server/scope.ts  (git: resolve PR/commit/range → worktree + diff spec)
   ├─ server/github.ts (gh: pr view / pr list)
   └─ store (reviews get `source` + `jobId`; findings get `draft`)
                                                       │
            Claude (headless) ──MCP──► this server's /mcp submit_review (with jobId) ──► review-created
```

| Unit | Responsibility |
|---|---|
| `src/server/claude-runner.ts` | Spawn `claude -p` with a prompt, cwd, allowed tools, MCP config; stream `stream-json` events; collect text/result; cancel; timeout. No knowledge of reviews. |
| `src/server/scope.ts` | Pure-ish git layer: `resolveScope(input) → { cwd, repoRoot, head, base, diffArgs, label, worktree? }`; worktree create/reuse/remove under `~/.review-app/worktrees/<hash>`; `listCommits(repo)`; `defaultBranch(repo)`. |
| `src/server/github.ts` | `parsePrUrl(url)`, `prInfo(repo, n)` via `gh pr view --json`, `listPrs(repo)` via `gh pr list --json`, `ghStatus()`. |
| `src/server/jobs.ts` | Job model + queue + SSE events; builds the review prompt from the scope; links the resulting review; runs draft jobs. |
| `src/server/review-prompt.ts` | Builds the headless review prompt from `skills/ai-review/SKILL.md` rules (single source of truth for severity rules) plus the scope-specific "what to review" section and the `jobId`. |
| `src/server/draft-prompt.ts` | Builds the reply-draft prompt from a finding (+ steps, code excerpt). |
| UI | `ReviewPanel.tsx` (modal with tabs), `JobCard.tsx`, `DraftReply` section in `CommentCard.tsx`, header label for `source`. |

### 3.1 Running Claude headless

Command (built by the runner; exact flags are the builder's to verify against `claude --help`, version 2.1.139 is installed):

```
claude -p <prompt> --output-format stream-json --no-session-persistence
       --permission-mode dontAsk
       --allowedTools "Read Grep Glob Bash(git diff *) Bash(git show *) Bash(git log *) Bash(git ls-files *) mcp__review-app__submit_review"
       --strict-mcp-config --mcp-config '{"mcpServers":{"review-app":{"type":"http","url":"http://127.0.0.1:4477/mcp"}}}'
       --add-dir <worktree or repo>
```

- cwd for **own-repo** scopes (Changes tab, commit at HEAD) = the user's repo: its `CLAUDE.md` and project settings apply, as they would in the user's own chat.
- cwd for **worktree** scopes (PRs, older commits) = a neutral empty directory `~/.review-app/sandbox/`, with the worktree given via `--add-dir`. The PR's `CLAUDE.md`, `.claude/settings.json` and hooks are therefore **not loaded**: a teammate's branch must not be able to inject instructions or run commands on the reviewer's machine. The prompt uses absolute paths and `git -C <worktree> …`. (Trade-off: the project's `CLAUDE.md` guidance is lost for PR reviews; the review prompt carries the severity rules itself, so quality impact is small.)
- Read-only by construction: no Edit/Write/general Bash in the allowlist; `dontAsk` denies anything else. Only user-level settings/hooks (the reviewer's own) are in play for worktree runs.
- Environment: strip `ELECTRON_RUN_AS_NODE` and `CLAUDECODE` from the child env (the app may be launched from a VS Code terminal); pass the user's env otherwise so `claude` finds its login.
- Draft jobs: same runner, `--output-format json`, allowed tools `Read Grep` only, no MCP; the result text is the draft.
- Timeouts: review 15 min, draft 2 min. Cancel = kill the process tree (`taskkill /T` on Windows).
- The MCP endpoint used by headless Claude is this very server; the review is linked by `jobId` (new optional field on `submit_review`, echoed into the prompt). If Claude finishes without calling `submit_review`, the job creates an empty review with `source` set and a note.

### 3.2 Data model additions

```ts
// Review
source?: {
  kind: "pr" | "commit" | "range" | "branch" | "changes";
  host?: "github" | "bitbucket";
  url?: string;               // PR URL
  number?: number;            // PR number
  title?: string;             // PR title or commit subject
  author?: string;
  repoName: string;
  repo: string;               // the user's local clone (absolute path): recent-repos, worktree cleanup, Send to Claude target
  base?: string;              // base ref / commit (exclusive)
  head: string;               // reviewed commit SHA
  branch?: string;
  checkout: string;           // absolute path code is served from (repoRoot stays = checkout for file access)
  worktree: boolean;          // true if `checkout` is a Ferret-owned worktree
};
jobId?: string;

// Review (cont.)
imported?: { by?: string; at: string };   // set by Import review

// Finding
draft?: string;               // reply for the PR author (user-editable)

// Job (in memory + ~/.review-app/jobs.json for history)
{ id, kind: "review" | "draft" | "draft-all", status: "queued"|"running"|"done"|"failed"|"cancelled",
  createdAt, startedAt?, endedAt?, label, scope?, reviewId?, findingId?, progress?: string,
  error?: string, logTail: string[] }
```

`repoRoot` of a PR review is the worktree path, so all existing file/anchor/VS Code-link code keeps working unchanged. "Changed lines" for the gutter: the file endpoint takes the diff base from `source.base` when present (`git diff <base>...<head> -- file`) instead of `HEAD`.

### 3.3 Worktrees

- Location: `~/.review-app/worktrees/<repoName>-<shortHash>/` created with `git -C <repo> worktree add --detach <path> <head>` after `git fetch origin pull/<n>/head` (GitHub) or `git fetch origin <branch>` (branch form).
- Reused when the same head is reviewed again; removed (`git worktree remove --force` + `git worktree prune`) when the last review pointing at it is deleted, and by a startup sweep for worktrees with no review.
- Never created for the Changes tab or for a commit that is the repo's current HEAD.
- The user's repo gains worktree metadata (`.git/worktrees/...`) but no checkout changes. This is the one "write" into the user's repo and it is documented in the README.

### 3.4 API

| Endpoint | Purpose |
|---|---|
| `GET /api/env` | `{ gh: { installed, loggedIn, user? }, claude: { installed, version? }, git: { installed } }` |
| `GET /api/repos` | recent repos (from reviews + jobs), newest first |
| `POST /api/pick-folder` (desktop only) | opens the native folder dialog; returns `{ path }` or `{ cancelled: true }` |
| `GET /api/repos/prs?repo=` | open PRs via `gh pr list` |
| `GET /api/repos/commits?repo=&limit=50` | recent commits + branches + default branch |
| `POST /api/jobs` | `{ kind: "review", scope: { type: "pr", url } \| { type: "pr", repo, number } \| { type: "branch", repo, branch, base? } \| { type: "commit", repo, sha } \| { type: "range", repo, from, to } \| { type: "changes", repo } }` → job |
| `POST /api/reviews/:id/findings/:fid/draft` | start a draft job for one finding |
| `POST /api/reviews/:id/draft-all` | draft every open finding (one job, sequential) |
| `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel` | job state, log tail, cancel |
| `GET /api/reviews/:id/export` | the portable Markdown (`text/markdown`) |
| `POST /api/reviews/import` | `{ text, repo?: string }` → the created review, or `{ needsRepo: { repoName, candidates: string[] } }` when the clone must be chosen |
| SSE | new event `job-updated { jobId }`; existing `review-created` still fires when Claude submits |

All mutating endpoints are JSON-only (same CSRF rule as today). `repo` paths are validated to exist and be git repos; the server never runs git with user-provided strings as options (always `--` separated, hashes validated `^[0-9a-f]{4,40}$`, branch names validated with `git check-ref-format --branch`).

### 3.5 MCP changes

- **New tool `prepare_review_scope`** `({ repo: string, scope: "changes" | { commit } | { range: "a..b" } | { branch, base? } | { pr: number | url } })` → `{ scopeId, checkout, isWorktree, head, base?, diffCommand, changedFiles: string[], label, source }`. It runs `scope.ts` (same engine as the panel). `scopeId` is a short-lived token (kept in memory for 1 hour) that `submit_review` uses to attach `source` and the checkout. For `changes`, it returns the repo itself and `git diff HEAD` + untracked files.
- `submit_review` gains optional `jobId` (panel runs) and `scopeId` (chat runs); either attaches `source`/`checkout`. Plain `/ai-review` without a scope (old behaviour) still works unchanged.
- Headless reviews use the same `submit_review` as chat reviews, so findings, steps, anchors and the UI are identical.

## 4. Decisions made

1. **Headless via the `claude` CLI, not the SDK package.** It's already installed and logged in, needs no extra dependency, and `stream-json` gives progress. (My call; the SDK can replace it later behind the same runner interface.)
2. **GitHub first via `gh`** (installed and logged in as `michalmiszczuk`). **Bitbucket PRs are reviewed by branch** for now: paste the source branch; no API token handling in this phase. (My call; a Bitbucket app-password integration is a later step.)
3. **Copy-paste replies, no posting.** (User's decision.)
4. **One job at a time, queued.** Keeps CPU/usage predictable and avoids two worktrees fighting. (My call.)
5. **Reviews are read-only runs.** Headless Claude gets no Edit/Write/general Bash. (Anti-goal above.)
6. **The ai-review skill stays the single source of the review rules**: the headless prompt is built from the same text so chat and app reviews rate severity the same way. (My call.)
7. **Empty result still creates a review** so a "nothing found" run is visible and re-runnable. (My call.)
8. **Draft reply works on every review kind**, not just PRs; the user may want a note for a commit author too. (My call.)
9. **No cloning.** A PR review needs the repo already cloned locally; the URL auto-selects a matching recent repo, otherwise the user points at the clone. (My call; cloning adds auth/disk handling that nobody asked for.)
10. **Send to Claude on every review**, pointed at the review's checkout folder (worktree for PRs). The user asks Claude about findings on teammates' PRs as well; fixes and edits on a PR snapshot stay in the snapshot. (User's decision.)
11. **Drafts don't wait behind a running review** (separate lane). (My call.)
12. **PR branches run isolated**: headless Claude never loads a reviewed branch's `CLAUDE.md`/hooks; the user's own repo keeps its config. (My call: security over a small quality loss.)
13. **One scope engine for both paths.** The chat skill asks Ferret to prepare the scope (`prepare_review_scope`) instead of doing git itself, so commit/branch/PR reviews from the chat get the same snapshot, label and code view as panel reviews. (My call.)
14. **The export is the share format.** One Markdown file that humans read and Ferret imports; no separate JSON format to explain to friends. Local paths are stripped on export. (User's wish, my format.)

## 5. Prompt sketches (builder refines)

**Review (headless):** the SKILL.md sections 2–4 verbatim (what to look for, severity rules, finding fields incl. `steps`), then a scope block:

> Review scope: pull request #218 "…" on repo `workflowbuilder`, head `3f2a…`, base `origin/main`. The working directory is a checkout of the PR head. Get the changes with `git diff origin/main...HEAD` and `git diff --name-only origin/main...HEAD`; read whole files for context. Report issues in or caused by the changes. When done, call `submit_review` with `repoRoot: "<cwd>"`, `scope: {kind:"files", target:[<changed files>]}`, `jobId: "<id>"`, `summary`, `findings`. Then reply with one line. Do not modify any files.

**Draft reply:** finding title/body/suggestion/steps, the code excerpt (anchored lines ±10), the PR context (title, author first name if known), and the shape rules from §2.3. Output only the comment text.

## 6. Testing

- **Unit:** the Markdown export (ordering, sections, drafts, dismissed), `parsePrUrl` (GitHub/Bitbucket, with/without trailing parts), origin-URL ↔ `owner/repo` matching (https/ssh/.git forms), range parsing, ref/hash validation, runner argument building (allowlist, mcp-config, env stripping), job queue transitions (queued→running→done/failed/cancelled, one at a time), worktree path naming, `source` label formatting, prompt builders (snapshot-ish: contains severity rules, jobId, diff command).
- **Integration with a fake `claude`:** a tiny Node script put first on PATH that reads the prompt, calls the real `/mcp` `submit_review` with a canned review including the `jobId`, and emits `stream-json` lines. Covers the full pipeline (job → runner → MCP → review linked → SSE) without real Claude. A second fake mode exits non-zero to test failure + log tail; a third hangs to test cancel/timeout. The fake also asserts the isolation contract: for worktree scopes it is launched with cwd = the sandbox dir and the worktree only in `--add-dir`.
- **Git fixtures:** temp repos with two branches to test `resolveScope` for commit/range/branch and worktree create/reuse/remove.
- **Manual E2E:** review a real GitHub PR (e.g. workflowbuilder #218) and one of the user's own commits from the panel; `/ai-review HEAD~3..HEAD` and `/ai-review #218` from the chat; Draft reply on a finding; Draft all; Export → Import into a fresh `REVIEW_APP_HOME` and confirm it opens at the same commit; delete the review and confirm the worktree is gone.

## 7. Error handling and edge cases

- `gh`/`claude`/`git` absence is detected up front (`/api/env`) and the panel disables what can't work, with the messages in §2.4.
- The server process must not die when `claude` crashes; runner errors become job failures.
- Cancel during fetch: the git process is killed, partial worktrees are removed.
- The app quitting with a running job: the job is killed and marked `cancelled` on next start (jobs.json).
- PR head moved since fetch: the job records the SHA it reviewed (`source.head`); the UI labels it, and a later review of the same PR gets a new worktree.
- Large PRs: the prompt tells Claude to cap findings (~25) and prefer whole-file reads of changed files only. No diff size limit in this phase; the 15-minute timeout is the guard.
- Non-ASCII paths (`ł`) in repo/worktree paths: pass through `execFile` arrays, never shell strings.

## 8. Settings and docs

- `~/.review-app/desktop.json` gains nothing; `~/.review-app/jobs.json` (history, last 100) and `~/.review-app/worktrees/` are new.
- README: a "Review a PR or commit from Ferret" section, the worktree note, and the `gh` requirement for GitHub PR lookup.

## 9. Looking ahead

**Next step: in-app chat.** The runner is designed as "spawn Claude with a prompt, stream events, allow a tool set, cwd" so the chat can reuse it with `--input-format stream-json` and an interactive permission handler. Jobs/SSE are generic enough to carry chat sessions. Nothing in this design assumes a review is the only thing the runner does. The chat replaces the VS Code round-trip of "Send to Claude" for discussing findings and steps; sending a fix to VS Code stays for the user's own PRs.

**After that: Send to ClickUp.** For a teammate's PR: pick a ClickUp task (search by name or paste a task link) and post the Markdown export (§2.4) as a comment and/or attach it as a `.md` file; optionally create a task. Needs a ClickUp API token stored in Ferret's settings. The export format is designed now so this step only adds the transport.

## 10. Left to the builder

- Exact `claude` flags and the `stream-json` event shapes (verify on 2.1.139); whether `--permission-mode dontAsk` plus an allowlist is the right read-only combination or `--permission-mode default` is needed.
- The modal's visual design within the existing Figma-style theme; keyboard handling.
- How "recent repos" is persisted (jobs.json is fine).
- Whether `gh pr list` needs `--limit` and which JSON fields to request.
- Where the fake-`claude` test helper lives and how PATH is overridden in tests on Windows (`.cmd` shim).
