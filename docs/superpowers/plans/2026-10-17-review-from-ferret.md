# Review from Ferret Implementation Plan (POC)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start reviews from Ferret (PR, commit, range, branch, uncommitted changes) by running Claude Code headless; the same scopes from the VS Code chat; per-finding reply drafts; and a portable Markdown export/import.

**Architecture:** A git **scope engine** (`scope.ts`) turns "what to review" into a checkout (user repo or a Ferret-owned worktree) plus a diff spec. A **runner** (`claude-runner.ts`) spawns `claude -p` with a read-only tool allowlist and streams progress. A **job manager** (`jobs.ts`) queues reviews (one at a time) and drafts (own lane), builds prompts, and links the review Claude submits through the existing MCP `submit_review` (new `jobId`/`scopeId`). The chat skill uses the same engine through a new MCP tool `prepare_review_scope`. Export/import is a pure Markdown-with-JSON-block format.

**Tech Stack:** existing Node 20+/TypeScript/Express/MCP SDK/React/Vite/Electron; `git` and `gh` CLIs via `execFile` (never a shell); `claude` CLI 2.1.139 (`-p`, `--output-format stream-json|json`, `--allowedTools`, `--permission-mode`, `--mcp-config`, `--strict-mcp-config`, `--add-dir`, `--no-session-persistence`).

**Spec:** `docs/superpowers/specs/2026-10-17-review-from-ferret-design.md`

**POC mode:** the user does not want tests written now. Each task ends with a **Verify** step: `npm run typecheck`, `npm run build`, the existing suite still green (`npm test`), and a quick scripted or manual check. A fake `claude` script (`tests/fake-claude/`) exists only as a dev helper to exercise the pipeline without spending Claude usage. A test pass can be added at the end of the phase.

## Global Constraints

- Nothing a review does may modify the user's working copy. Git writes go only to `~/.review-app/worktrees/<repoName>-<shortHash>/` (plus the unavoidable `.git/worktrees` metadata in the user's repo). Worktree scopes run Claude with cwd = `~/.review-app/sandbox/` (empty dir) and the worktree only via `--add-dir`; own-repo scopes (Changes, commit at HEAD) run with cwd = the repo.
- Headless Claude is read-only: allowlist exactly `Read Grep Glob Bash(git diff *) Bash(git show *) Bash(git log *) Bash(git ls-files *) mcp__review-app__submit_review` for reviews; `Read Grep` for drafts; `--permission-mode dontAsk`; `--strict-mcp-config` with only this server's `/mcp`. Child env: copy of `process.env` minus `ELECTRON_RUN_AS_NODE` and `CLAUDECODE`.
- Timeouts: review 15 min, draft 2 min. One review job at a time (FIFO); drafts in a separate lane, sequential per review.
- Git/gh are always run with `execFile` and argument arrays; user strings never become options: hashes must match `^[0-9a-f]{4,40}$`, refs must pass `git check-ref-format --branch`, paths go after `--`.
- All mutating endpoints are JSON-only (`req.is("application/json")` → else 415), as today. Host guard unchanged.
- `repoRoot` of a review = the checkout code is served from (`source.checkout`), so existing file/anchor/VS Code-link code keeps working.
- Data: `~/.review-app/jobs.json` (last 100 jobs), `~/.review-app/worktrees/`, `~/.review-app/sandbox/`. `REVIEW_APP_HOME` override applies to all.
- Export block fence: ` ```json ferret-review ` … ` ``` `, content `{ "formatVersion": 1, "review": … }` with `repoRoot`, `source.checkout`, `source.repo`, `sessionId`, `projectDir` stripped.
- Dark theme, Figma-style, existing tokens in `src/ui/styles.css`. Copy: button **Review ▶**, tabs **Pull request / Commit / Changes**, **Start review**, **Draft reply**, **Draft all**, **Export ▾** (Copy Markdown / Save .md…), **Import review…**, **Ask about this step**.
- **Commits:** the user commits by hand. At each "Commit checkpoint", stop and list the files plus a one-line message. Never run `git commit`.

## Review Focus

Checked by hand in the Verify steps (no automated tests in POC mode):

1. **A PR branch that contains a `CLAUDE.md` / `.claude/settings.json` with hooks** must not have them loaded. Task 5 Verify: a worktree scope's `RunOptions.cwd` is the sandbox dir and the worktree is only in `addDirs`; Task 8 Verify: the fake claude's log shows that cwd.
2. **Non-ASCII repo paths and worktree names** (`C:\Users\MichałMiszczuk\…`). Task 2 Verify: a worktree created under the real home shows in `git worktree list`.
3. **Cancel or quit mid-review**: no orphan `claude`/`git` process, job ends `cancelled`. Task 4 Verify (cancel the fake in `hang` mode, check the PID is gone); Task 5 (jobs.json marks running jobs cancelled on load).
4. **Claude finishes without calling `submit_review`**: an empty review with `source` and the note "Claude found nothing to report". Task 8 Verify with the fake in `ok` mode.
5. **Importing a file for a repo the importer has, but at a commit they don't**: opens against current files with re-anchoring. Task 9 Verify.

---

## File Structure

```
src/shared/
  schema.ts            # + reviewSourceSchema, review.source/jobId/imported, finding.draft, patch.draft, submit jobId/scopeId
  api-types.ts         # + Job types, EnvStatus, StoreEvent job-updated, PrSummary, CommitSummary
  git-parse.ts         # NEW pure: parsePrUrl, ownerRepoFromOrigin, originMatches, isSha, parseRange, sourceLabel
  export.ts            # NEW pure: exportReview, parseExport, PortableReview
src/server/
  scope.ts             # NEW git engine: repo queries, resolveScope, worktrees
  github.ts            # NEW gh wrapper: status, prInfo, listPrs
  claude-runner.ts     # NEW: buildClaudeArgs, childEnv, parseStreamLine, runClaude
  prompts.ts           # NEW: skillRules, buildReviewPrompt, buildDraftPrompt, buildReviewRun, buildDraftRun
  jobs.ts              # NEW: JobManager (queue, lanes, persistence, scope registry, linking)
  import.ts            # NEW: importReview
  store.ts             # create(input, extras), FindingUpdate + draft, findBySourceHead
  mcp.ts               # prepare_review_scope; submit_review jobId/scopeId
  api.ts               # createApiRouter(store, opts: ApiOptions); new routes; changedLines vs source.base
  index.ts             # ApiOptions threading; JobManager construction; startup sweep
  files.ts             # changedLinesBetween(repo, base, head, rel)
src/cli/index.ts, src/desktop/main.ts   # pickFolder / saveFile / env wiring
src/ui/
  api.ts               # new calls
  App.tsx              # Review panel + job cards + export/import + draft wiring
  components/ReviewPanel.tsx, JobCard.tsx, SourceLabel.tsx, ExportMenu.tsx   # NEW
  components/Header.tsx, CommentCard.tsx, StepBubble.tsx, PathSteps.tsx, FindingsList.tsx   # modified
skills/ai-review/SKILL.md               # scopes via prepare_review_scope
tests/fake-claude/claude.cjs, claude.cmd   # dev helper only
scripts/try-review.ts                      # dev helper: start a review job against the running app
```

---

### Task 1: Schema and store additions

**Files:** Modify `src/shared/schema.ts`, `src/shared/api-types.ts`, `src/server/store.ts`.

**Interfaces:**
- Produces (schema.ts):
  - `reviewSourceSchema` / `ReviewSource = { kind: "pr"|"commit"|"range"|"branch"|"changes"; host?: "github"|"bitbucket"; url?: string; number?: number; title?: string; author?: string; repoName: string; repo: string; base?: string; head: string; branch?: string; checkout: string; worktree: boolean }`
  - `reviewSchema` gains `source?: ReviewSource`, `jobId?: string`, `imported?: { by?: string; at: string }`
  - `findingSchema` gains `draft?: string`; `findingPatchSchema` gains `draft: z.string().max(4000).optional()` (still `.strict()`)
  - `submitReviewShape` gains `jobId?: string`, `scopeId?: string` (`.optional().describe(...)`: "set when the review was started from Ferret / prepared with prepare_review_scope")
- Produces (api-types.ts): `StoreEvent = { type: "review-created"|"review-updated"|"review-deleted"; reviewId: string } | { type: "job-updated"; jobId: string }`
- Produces (store.ts): `create(input: SubmitReviewInput, extras?: { source?: ReviewSource; jobId?: string; imported?: Review["imported"] }): Promise<Review>` (extras copied onto the review; `repoRoot` stays `input.repoRoot`); `FindingUpdate` includes `draft`; `findBySourceHead(repo: string, head: string): Review | undefined`.

- [ ] **Step 1: Implement** the above.
- [ ] **Step 2: Verify:** `npm run typecheck` clean; `npm test` still green (existing tests only). Fix any test that breaks because `StoreEvent` changed shape (UI subscribe narrowing).
- [ ] **Step 3: Commit checkpoint** — `src/shared/schema.ts src/shared/api-types.ts src/server/store.ts` — `Add review source, jobs and draft fields`

---

### Task 2: Pure git parsing helpers and the scope engine

**Files:** Create `src/shared/git-parse.ts`, `src/server/scope.ts`.

**Interfaces:**
- `git-parse.ts` (pure, browser-safe):
  - `parsePrUrl(url: string): { host: "github"|"bitbucket"; ownerRepo: string; number: number } | null` — GitHub `…/pull/218[/files]`, Bitbucket `…/pull-requests/42[/…]`.
  - `ownerRepoFromOrigin(originUrl: string): string | null` — `https://github.com/a/b.git`, `git@github.com:a/b.git`, `ssh://git@bitbucket.org/a/b` → `a/b`.
  - `originMatches(originUrl: string, ownerRepo: string): boolean` (case-insensitive).
  - `isSha(s: string): boolean` (`^[0-9a-f]{4,40}$`, case-insensitive); `parseRange(s: string): { from: string; to: string } | null` (`a..b`, `a...b`).
  - `sourceLabel(source: ReviewSource): string` → `PR #218 · wb · <title>` / `commit 3f2a1c9 · <title>` / `<from>..<to>` / `<branch> vs <base>` / `uncommitted changes`.
- `scope.ts`:
  - `ScopeInput = { type:"changes"; repo } | { type:"commit"; repo; sha } | { type:"range"; repo; from; to } | { type:"branch"; repo; branch; base?: string } | { type:"pr"; repo; number; host?: "github" }`
  - `ResolvedScope = { source: ReviewSource; checkout: string; isWorktree: boolean; diffCommand: string; changedFiles: string[]; label: string }`
  - `PrInfo = { number; title; author; url; headRefName; baseRefName; headSha }`, `PrInfoFn = (repo: string, n: number) => Promise<PrInfo>`
  - `isGitRepo(dir)`, `originUrl(repo)`, `defaultBranch(repo)` (origin/HEAD → `main` → `master`), `headSha(repo)`, `listCommits(repo, limit = 50): Promise<CommitSummary[]>` (`{ sha, short, subject, author, date }`), `listBranches(repo)`, `validateRef(repo, ref)` (`git check-ref-format --branch`), `repoNameOf(repo)`.
  - `resolveScope(input: ScopeInput, deps: { worktreesDir: string; prInfo?: PrInfoFn }): Promise<ResolvedScope>`. Diff rules: changes → `git diff HEAD` + untracked, no worktree; commit → base `<sha>^`, `git show <sha>`; range → `git diff <from>...<to>`; branch → `git diff <base>...<branch>`; pr → `git fetch origin pull/<n>/head` + `git fetch origin <baseRefName>`, head = fetched SHA, base `origin/<baseRefName>`. Worktree when head ≠ repo HEAD (never for changes). `changedFiles` via `--name-only`. Errors: `ScopeError` with messages "not a git repo", "invalid commit <x>", "invalid ref <x>", "Fetch failed: <git stderr first line>".
  - `ensureWorktree(repo, head, worktreesDir): Promise<string>` (`<worktreesDir>/<repoName>-<head.slice(0,7)>`, `git -C repo worktree add --detach <path> <head>`, reuse if present), `removeWorktree(repo, path)` (`worktree remove --force` + `prune`), `listFerretWorktrees(worktreesDir)`.

- [ ] **Step 1: Implement** both files (all git through `execFile("git", ["-C", repo, ...])`, `--` before paths).
- [ ] **Step 2: Verify:** typecheck; `npx tsx -e` one-liners against this repo: `resolveScope({type:"commit", repo: ".", sha: "<HEAD~1>"}, {worktreesDir: "<REVIEW_APP_HOME>/worktrees"})` creates a worktree under the real home (with `ł`), `git worktree list` shows it, `removeWorktree` removes it; `parsePrUrl("https://github.com/synergycodes/workflowbuilder/pull/218/files")` → number 218.
- [ ] **Step 3: Commit checkpoint** — `src/shared/git-parse.ts src/server/scope.ts` — `Add git scope engine`

---

### Task 3: GitHub lookup via gh

**Files:** Create `src/server/github.ts`.

**Interfaces:** `type Exec = (file: string, args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string; code: number }>`; `createGithub(exec?: Exec)` → `{ status(): Promise<{ installed: boolean; loggedIn: boolean; user?: string }>; prInfo(repo, n): Promise<PrInfo>; listPrs(repo): Promise<PrSummary[]> }`, `PrSummary = { number; title; author; updatedAt; url; headRefName }`. Commands: `gh pr view <n> --json number,title,author,url,headRefName,baseRefName,headRefOid`, `gh pr list --limit 30 --json number,title,author,updatedAt,url,headRefName`, `gh auth status`, `gh api user --jq .login`. Failures → `GithubError` with the spec §2.7 copy ("GitHub CLI isn't available/logged in. Install it and run `gh auth login`, or review by branch instead."). On Windows `gh` resolves via PATH (`gh.exe`); use `execFile` without shell.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify:** `npx tsx -e` → `status()` shows `user: "michalmiszczuk"`; `listPrs("C:/Users/MichałMiszczuk/Code/workflowbuilder")` lists PR #218.
- [ ] **Step 3: Commit checkpoint** — `src/server/github.ts` — `Add GitHub PR lookup`

---

### Task 4: Claude runner + fake CLI (dev helper)

**Files:** Create `src/server/claude-runner.ts`, `tests/fake-claude/claude.cjs`, `tests/fake-claude/claude.cmd`.

**Interfaces:**
- `RunOptions = { prompt: string; cwd: string; addDirs?: string[]; allowedTools: string[]; mcp?: { name: string; url: string }; outputFormat: "stream-json"|"json"; timeoutMs: number; claudePath?: string; env?: NodeJS.ProcessEnv }`
- `buildClaudeArgs(o: RunOptions): string[]` → `["-p", prompt, "--output-format", fmt, "--no-session-persistence", "--permission-mode", "dontAsk", "--allowedTools", allowedTools.join(" "), ...addDirs.flatMap(d => ["--add-dir", d]), ...(mcp ? ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { [mcp.name]: { type: "http", url: mcp.url } } })] : [])]`
- `childEnv(base = process.env): NodeJS.ProcessEnv` (drops `ELECTRON_RUN_AS_NODE`, `CLAUDECODE`)
- `parseStreamLine(line: string): { type: "progress"; text: string } | { type: "result"; text: string; isError: boolean } | null` — stream-json `assistant` → progress from `tool_use` names/inputs ("Reading src/a.ts", "git diff …") or first 80 chars of text; `result` → `{ text: result, isError: is_error }`.
- `runClaude(o: RunOptions): RunHandle`; `class RunHandle extends EventEmitter { done: Promise<RunResult>; pid?: number; cancel(): void }` emits `progress` (string) and `log` (raw line); `RunResult = { ok: boolean; exitCode: number|null; resultText: string; isError: boolean; logTail: string[] /* last 60 */; cancelled: boolean; timedOut: boolean }`. Spawn with `spawn(file, args, { cwd, env, windowsHide: true, shell: false })`; on Windows the real `claude` is a `.cmd`/`.ps1` shim: resolve the actual entry (`where claude` → if `.cmd`, read it or run via `cmd.exe /d /s /c` **with args passed through `spawn`'s array, never concatenated**; builder picks the robust option and verifies prompts with quotes, `&`, newlines and `ł` survive). Cancel: `taskkill /T /F /PID` on Windows, `SIGTERM` elsewhere; timeout = cancel + `timedOut: true`.
- Fake: `tests/fake-claude/claude.cjs` modes via `FAKE_CLAUDE_MODE`: `ok` (two `assistant` lines + `result`), `error` (stderr "boom", exit 2), `hang` (60 s), `submit` (POST a canned 2-finding review to the MCP URL from `--mcp-config`, with `jobId` extracted from the prompt, then `result`). Writes `{ cwd, argv, env: { ELECTRON_RUN_AS_NODE, CLAUDECODE } }` to `FAKE_CLAUDE_LOG` when set. `claude.cmd`: `@node "%~dp0claude.cjs" %*`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify:** typecheck; `npx tsx -e` running the fake (`claudePath: tests/fake-claude/claude.cmd`) in `ok` → `ok: true`; `error` → `exitCode 2`, log has "boom"; `hang` + cancel after 300 ms → `cancelled: true` and `process.kill(pid, 0)` throws (Review Focus 3); a prompt containing `"quotes" & ampersand\nnewline ł` reaches the fake intact (check its log).
- [ ] **Step 3: Commit checkpoint** — `src/server/claude-runner.ts tests/fake-claude` — `Add headless Claude runner`

---

### Task 5: Prompts and the job manager

**Files:** Create `src/server/prompts.ts`, `src/server/jobs.ts`.

**Interfaces:**
- `prompts.ts`: `skillRules(skillText: string): string` (text of `## 2.` through the end of `## 4.` of `skills/ai-review/SKILL.md`); `buildReviewPrompt(a: { scope: ResolvedScope; jobId: string; rules: string }): string` (rules + spec §5 scope block: `diffCommand`, `changedFiles`, `checkout`, "Do not modify any files", exact `submit_review` call with `repoRoot: "<checkout>"`, `scope: { kind: "files", target: changedFiles }`, `jobId`; worktree scopes: "use `git -C <checkout> …`"); `buildDraftPrompt(a: { finding: Finding; review: Review; excerpt: string }): string` (spec §2.3 shape, "Output only the comment text", ≤120 words); `buildReviewRun(scope, jobId, deps: { rules; mcpUrl; sandboxDir }): RunOptions` (own-repo: `cwd = checkout`; worktree: `cwd = sandboxDir`, `addDirs = [checkout]`; allowlist/timeout per Global Constraints; `stream-json`); `buildDraftRun(review, finding, excerpt): RunOptions` (`cwd = review.repoRoot`, `["Read","Grep"]`, `json`, 2 min, no mcp).
- `jobs.ts`: `Job = { id; kind: "review"|"draft"|"draft-all"; status: "queued"|"running"|"done"|"failed"|"cancelled"; createdAt; startedAt?; endedAt?; label; scope?: ScopeInput; reviewId?; findingId?; progress?; error?; logTail: string[]; note? }` (export the wire type from `api-types.ts` too); `class JobManager extends EventEmitter` — `constructor(deps: { store: ReviewStore; home: string; mcpUrl: string; rules: string; runner?: typeof runClaude; resolveScope?: typeof resolveScope; prInfo?: PrInfoFn; claudePath?: string })`; `load()` (reads `jobs.json`; `running`/`queued` → `cancelled`); `startReview(input: ScopeInput): Job`; `startDraft(reviewId, findingId): Job`; `startDraftAll(reviewId, redo = false): Job`; `cancel(id)`; `list()`; `get(id)`; `registerScope(s: ResolvedScope): string` (`s_…`, 1 h TTL); `takeScope(id)`; `scopeForJob(jobId)`; `reviewSubmitted(jobId, reviewId)`; emits `"change"` `{ type: "job-updated", jobId }`. Lanes: review FIFO one at a time; draft lane separate. Review job flow: resolveScope ("Fetching…") → run ("Reviewing N files…", progress relayed) → `ok` without `reviewSubmitted` → `store.create({ repoRoot: checkout, scope: { kind: "files", target: changedFiles.length ? changedFiles : ["."] }, summary: "Claude found nothing to report.", findings: [] }, { source, jobId })` + `note`; `!ok` → `failed` with first stderr/log line + `logTail`. Draft job: excerpt = anchored lines ±10 (`readRepoFile` + `reanchor`) → result text → `store.updateFinding(id, { draft })`. Draft-all: open findings in list order; skip drafted unless `redo`. Persist after each change (last 100).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify:** typecheck; `npx tsx -e` with a fake runner: start two reviews → second waits; a draft starts while a review runs; `buildReviewRun` for a worktree scope has `cwd === sandboxDir` and `addDirs === [checkout]` (Review Focus 1); kill the process with a job `running` → next `load()` shows it `cancelled`.
- [ ] **Step 3: Commit checkpoint** — `src/server/prompts.ts src/server/jobs.ts` — `Add review prompts and job manager`

---

### Task 6: MCP: `prepare_review_scope` and linking on `submit_review`

**Files:** Modify `src/server/mcp.ts`, `src/server/index.ts`.

**Interfaces:** `mountMcp(app, store, getBaseUrl, deps?: { jobs?: JobManager; resolveScope?: typeof resolveScope; prInfo?: PrInfoFn; worktreesDir: string })`; tool `prepare_review_scope({ repo: string, scope: "changes" | { commit: string } | { range: string } | { branch: string; base?: string } | { pr: number | string } })` → `{ scopeId, checkout, isWorktree, head, base?, diffCommand, changedFiles, label, source }` (PR string → `parsePrUrl`; errors → `isError`). `submit_review`: `jobId` → `scopeForJob` → `store.create({ ...input, repoRoot: scope.checkout }, { source, jobId })` + `jobs.reviewSubmitted`; `scopeId` → `takeScope` → create with `source`; unknown id → `isError` "unknown job/scope"; neither → unchanged.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify:** typecheck; `npm test` (existing MCP tests) green; with the app running, an MCP client script (`scripts/try-scope.ts`, dev helper) calls `prepare_review_scope {repo: ".", scope: "changes"}` and prints the result.
- [ ] **Step 3: Commit checkpoint** — `src/server/mcp.ts src/server/index.ts scripts/try-scope.ts` — `Add prepare_review_scope tool`

---

### Task 7: REST API for env, repos, jobs, drafts; diff-aware changed lines

**Files:** Modify `src/server/api.ts`, `src/server/index.ts`, `src/server/files.ts`, `src/shared/api-types.ts`, `src/cli/index.ts`, `src/desktop/main.ts`.

**Interfaces:** `createApiRouter(store, opts: ApiOptions)`, `ApiOptions = { claude?; openExternal?; jobs?: JobManager; github?: ReturnType<typeof createGithub>; pickFolder?: () => Promise<string|null>; saveFile?: (suggestedName: string, content: string) => Promise<string|null>; claudeInstalled?: () => Promise<{ installed: boolean; version?: string }> }` (and `startServer` opts gain the same). Routes:
- `GET /api/env` → `EnvStatus = { gh: { installed; loggedIn; user? }; claude: { installed; version? }; git: { installed } }`
- `GET /api/repos` → `{ repos: string[] }` (distinct `source.repo`/`repoRoot` of reviews + jobs' scopes, newest first)
- `GET /api/repos/info?repo=` → `{ isRepo, repoName, originOwnerRepo, defaultBranch, head, branches }` (400 if not a repo)
- `GET /api/repos/prs?repo=` → `PrSummary[]`; `GET /api/repos/commits?repo=&limit=` → `CommitSummary[]`
- `POST /api/jobs` body `{ kind: "review", scope: ScopeInput }` or `{ kind: "review", scope: { type: "pr", url, repo? } }` (URL → `parsePrUrl`; missing `repo` → 409 `{ needsRepo: { ownerRepo, candidates } }`, candidates = recent repos whose origin matches) → 201 `Job`
- `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`
- `POST /api/reviews/:id/findings/:fid/draft` → `Job`; `POST /api/reviews/:id/draft-all` body `{ redo?: boolean }` → `Job`
- `POST /api/pick-folder` → `{ path }` | `{ cancelled: true }` (404 without `pickFolder`); `POST /api/save-file` `{ name, content }` → `{ path }` | `{ cancelled: true }`
- SSE `/api/events` also relays `jobs` `"change"` events.
- `GET /api/reviews/:id/file`: with `review.source?.base` → `changedLinesBetween(review.repoRoot, source.base, source.head, rel)` (new in `files.ts`: `git diff --unified=0 <base>...<head> -- rel`, same hunk parser), else as today.
- Desktop: `pickFolder` via `dialog.showOpenDialog({ properties: ["openDirectory"] })`, `saveFile` via `dialog.showSaveDialog` + `fs.writeFile`; `claudeInstalled` via `execFile("claude", ["--version"], { env: childEnv() })`.

- [ ] **Step 1: Implement** (incl. the `createApiRouter` signature change at all call sites).
- [ ] **Step 2: Verify:** typecheck, `npm test` green, build; with the app running: `curl /api/env` shows gh user + claude version; `POST /api/jobs {kind:"review", scope:{type:"changes", repo:"<this repo>"}}` with env `REVIEW_APP_CLAUDE=tests/fake-claude/claude.cmd` (new env override read by `startServer` → `claudePath`) returns 201 and SSE shows `job-updated`.
- [ ] **Step 3: Commit checkpoint** — `src/server/api.ts src/server/index.ts src/server/files.ts src/shared/api-types.ts src/cli/index.ts src/desktop/main.ts` — `Add jobs and repo API`

---

### Task 8: Pipeline check with the fake claude (dev helper, no test file)

**Files:** Create `scripts/try-review.ts`.

- [ ] **Step 1: Write `scripts/try-review.ts`:** args `<repo> [sha|changes]`; starts a job through `POST /api/jobs` on the running app and polls `GET /api/jobs/:id` until terminal, printing progress; prints the linked review id/url and the fake's log (`FAKE_CLAUDE_LOG`) when set. Add `"try:review": "tsx scripts/try-review.ts"`.
- [ ] **Step 2: Verify** (app started with `REVIEW_APP_CLAUDE=tests/fake-claude/claude.cmd FAKE_CLAUDE_MODE=submit FAKE_CLAUDE_LOG=<tmp>`): review an older commit of this repo → job `done`, review has `source.kind "commit"`, `source.worktree true`, `repoRoot` under `worktrees/`; the fake log's `cwd` is the sandbox dir and `--add-dir` the worktree (Review Focus 1); the code view shows the worktree's file. `FAKE_CLAUDE_MODE=ok` → empty review with the "nothing to report" note (Review Focus 4). `error` → `failed` with "boom" in the log tail. Then one **real** run (no override) on `changes` of this repo to see real progress lines and a real review.
- [ ] **Step 3: Commit checkpoint** — `scripts/try-review.ts package.json` (+ fixes) — `Add review pipeline helper`

---

### Task 9: Portable export and import

**Files:** Create `src/shared/export.ts`, `src/server/import.ts`; modify `src/server/api.ts`.

**Interfaces:** `PortableReview` (Review minus `repoRoot|sessionId|projectDir`, `source` minus `checkout|repo`), `portableReviewSchema`; `toPortable(review): PortableReview`; `exportReview(review, opts?: { by?: string }): string` (human part per spec §2.4, severity order, "Reply" per draft, "Dismissed" section, then the fenced block); `parseExport(text): { ok: true; review: PortableReview; by?: string } | { ok: false; error: string }` (fenced block or bare JSON). `importReview(p: PortableReview, repo: string, deps: { store; worktreesDir; by?: string }): Promise<Review>` — if `p.source?.head` and `git cat-file -e <head>` → `ensureWorktree`, `repoRoot = worktree`, `source.worktree = true`; else `repoRoot = repo`, `worktree = false`; `source.repo = repo`, `source.checkout = repoRoot`; findings/status/drafts/notes copied; `imported: { by, at }`; new id. Routes: `GET /api/reviews/:id/export` (`text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename="ferret-review-<id>.md"`); `POST /api/reviews/import` `{ text; repo? }` → 201 | 409 `{ needsRepo: { repoName, candidates } }` | 400 `{ error }`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify:** typecheck; export a real review via `curl` and read the Markdown (no local path inside; block parses); import it with `REVIEW_APP_HOME` pointed at a scratch home via `review-app start` on the CLI build and a `curl` POST: once with a repo that has the commit (worktree created) and once with a shallow/unknown-head repo (opens on current files, Review Focus 5).
- [ ] **Step 3: Commit checkpoint** — `src/shared/export.ts src/server/import.ts src/server/api.ts` — `Add portable review export/import`

---

### Task 10: Chat skill scopes

**Files:** Modify `skills/ai-review/SKILL.md`.

- [ ] **Step 1: Rewrite §1 Scope:** argument forms → `scope` for `prepare_review_scope` (none → `"changes"`; path(s) → old files behaviour without the tool; `a..b` → `{ range }`; sha → `{ commit }`; `#n`/PR URL → `{ pr }`; other word → `{ branch }`); call the tool with `repo` = repo root; read files in the returned `checkout`, use `git -C <checkout>` for the `diffCommand`, review the `changedFiles`; pass `scopeId` and `repoRoot: <checkout>` to `submit_review`; keep `sessionId`/`projectDir`; reply line unchanged. Mention the four examples `HEAD~3..HEAD`, `<sha>`, `feature/x`, `#218`.
- [ ] **Step 2: Verify:** `npm test` (the skill-text tests in `tests/cli/setup.test.ts` still pass; extend the expected strings there only if they now fail); after "Update Claude", run `/ai-review HEAD~3..HEAD` in a chat and see the review with a `range` source label.
- [ ] **Step 3: Commit checkpoint** — `skills/ai-review/SKILL.md` — `Teach /ai-review commit, branch and PR scopes`

---

### Task 11: UI: Review panel, job cards, source label

**Files:** Create `src/ui/components/ReviewPanel.tsx`, `JobCard.tsx`, `SourceLabel.tsx`; modify `src/ui/api.ts`, `App.tsx`, `Header.tsx`, `FindingsList.tsx`, `styles.css`.

**Interfaces:**
- `api.ts`: `fetchEnv()`, `fetchRepos()`, `fetchRepoInfo(repo)`, `fetchPrs(repo)`, `fetchCommits(repo)`, `startJob(body)`, `fetchJobs()`, `cancelJob(id)`, `pickFolder()`, `startDraft(reviewId, findingId)`, `startDraftAll(reviewId, redo)`, `fetchExport(reviewId)`, `importReview(text, repo?)`, `saveFile(name, content)`.
- `ReviewPanel({ open, onClose, onStarted(job: Job) })`: tabs **Pull request / Commit / Changes**; repo picker (recent + Browse… via `pickFolder`, text field fallback on 404); PR tab: URL field + open-PR list, auto-select the recent repo whose origin matches (`originMatches` vs `fetchRepoInfo(...).originOwnerRepo`), Bitbucket URL → branch form; Commit tab: last-50 list, click = single, shift-click = range, plus branch-vs-base; env warnings with spec §2.7 copy; **Start review** → `startJob` → `onStarted`; `Esc` closes.
- `JobCard({ job, onCancel, onOpenReview })`: spinner + progress + elapsed; `failed` → error + "Show log" `<details>`; `done` → counts + Open; `queued` → "Queued, N ahead".
- `SourceLabel({ source })` → `sourceLabel()` text, PR title as an `<a href>` (the existing external-link handling opens it).
- `App.tsx`: `jobs` state (`fetchJobs` + SSE `job-updated`); **Review ▶** in the header opens the panel; non-terminal (and recently finished) jobs render as `JobCard`s above the list (`FindingsList` gets `top?: ReactNode`); job `done` with `reviewId` and no review open → open it (else the existing "New review arrived" toast); header uses `SourceLabel` when `review.source`; switcher options use `sourceLabel` when present.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify:** typecheck, build, `npm test` green; `npm run screenshot` with `?panel=review` (small dev hook in App that opens the panel) and one with a running job card (fake claude in `hang` mode); check against the Figma-style theme.
- [ ] **Step 3: Commit checkpoint** — `src/ui/**` — `Add Review panel and job cards`

---

### Task 12: UI: drafts, export/import, step questions, snapshot hint

**Files:** Create `src/ui/components/ExportMenu.tsx`; modify `CommentCard.tsx`, `StepBubble.tsx`, `PathSteps.tsx`, `Header.tsx`, `App.tsx`, `styles.css`.

**Interfaces:**
- `CommentCard` props gain `onDraft(): void`, `drafting: boolean`, `snapshotHint?: string`, `presetMessage?: string`; renders **Draft reply** (or **Regenerate** when `finding.draft`), a **Reply to author** textarea bound to `finding.draft` (saved on blur via `onUpdate({ draft })`), **Copy** (clipboard + toast), the hint line when set; `presetMessage` replaces the message box text and focuses it when it changes.
- `PathSteps`/`StepBubble` gain `onAsk?(i: number)` → **Ask about this step** → App sets `presetMessage = "About step ${i+1} (${note}): "`.
- `Header` gains **Draft all** (when `review.source` and open findings exist; confirm "Redo all?" when some have drafts), `ExportMenu` (**Export ▾**: Copy Markdown; Save .md… via `saveFile`, download link fallback on 404) and **Import review…** (file input `.md,.json`; App also handles window `drop`) → `importReview(text)`; 409 `needsRepo` → the Review panel's repo chooser; success → open the review.
- App: `sendFinding` folder = `review.source?.checkout ?? realValue(review.projectDir) ?? review.repoRoot`; `snapshotHint` when `review.source?.worktree`: `Snapshot of ${label} — Claude's edits here don't touch your checkout; use Draft reply to tell the author`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify:** typecheck, build, `npm test` green; screenshot a card with a draft and the hint; Copy puts the draft on the clipboard; Export ▾ → Copy Markdown gives the file text.
- [ ] **Step 3: Commit checkpoint** — `src/ui/**` — `Add reply drafts, export/import and step questions`

---

### Task 13: Desktop wiring, startup sweep, docs, manual E2E

**Files:** Modify `src/desktop/main.ts`, `src/cli/index.ts`, `src/server/index.ts`, `README.md`.

**Interfaces:** `startServer` constructs `JobManager` (rules from the bundled `skills/ai-review/SKILL.md`, `mcpUrl` = own `/mcp`, `home`, `claudePath` from `REVIEW_APP_CLAUDE`), calls `jobs.load()`, runs `sweepWorktrees(store, worktreesDir)` (remove Ferret worktrees no review points at; also on review delete when unreferenced); desktop passes `pickFolder`, `saveFile`, `claudeInstalled`.

- [ ] **Step 1: Implement wiring + README** ("Review a PR or commit from Ferret", worktree note, `gh` requirement, export/import and sharing, chat scopes).
- [ ] **Step 2: Verify:** typecheck, build, `npm test` green. **Manual E2E with the user** (restart the app, click Update Claude):
  1. Review ▶ → Pull request → paste `https://github.com/synergycodes/workflowbuilder/pull/218` → repo auto-selected → Start → job card → review "PR #218 · workflowbuilder · …", code from the snapshot, changed lines marked.
  2. Review ▶ → Commit → latest commit of review-app → `source.worktree === false`; Send to Claude works as before.
  3. Draft reply → text + Copy; Draft all → counter.
  4. Export ▾ → Save .md; Import review… into a scratch `REVIEW_APP_HOME` (CLI build + browser) → opens at the same commit.
  5. Chat: `/ai-review HEAD~3..HEAD`, `/ai-review #218` → source labels.
  6. Delete the PR review → worktree folder gone; `git worktree list` clean.
  7. Cancel a running review → `cancelled`, no `claude` process left.
- [ ] **Step 3: Commit checkpoint** — `src/desktop/main.ts src/cli/index.ts src/server/index.ts README.md` — `Wire review jobs into the app`
