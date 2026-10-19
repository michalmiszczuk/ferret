# Ferret — project status (2026-10-17)

Hand-off note so work can resume after a context reset. Repo: `C:\Users\MichałMiszczuk\Code\review-app`, branch `feat/review-app`. Product name **Ferret**; internal names (MCP server, `review-app://` link, `~/.review-app` data dir, package name) are still `review-app`.

## What Ferret is

A local **triage desk for AI code reviews**. Claude Code (in VS Code) reviews code and submits structured findings over MCP (`submit_review`); Ferret shows them sorted by severity (🔴🟠🟡🟢 hexagon "gems") with the real code and the comment inline, re-anchored by snippet when the file changes. The user sends findings back to Claude with a message ("Send to Claude" → opens the Claude tab in VS Code pre-filled with `/apply-review <review> <finding> <message>`; Claude fixes or answers; `mark_done` shows the answer on the card). Multi-place findings have a numbered **path** of steps. Dark Figma-style UI, user's VS Code theme (Ayu Mirage) for code, Electron desktop app with tray; also a terminal version (`review-app start`).

Key docs: `docs/superpowers/specs/2026-10-15-review-app-design.md` (v1), `2026-10-16-desktop-app-design.md` (Electron), `2026-10-17-review-from-ferret-design.md` (current step). Plans in `docs/superpowers/plans/`.

## Done and committed (through `9da69f9 Fix review findings`)

v1 server/UI/MCP, Electron shell + installer config, Figma-style UI, Connect/Update Claude button, delete/clear reviews, per-finding messages, VS Code deep link (focus the right window + Claude tab), VS Code theme in the code view, read-only `/api/sent` watcher endpoint, paths (steps), rename to Ferret + logo, gems, per-click severity filters, final-review fixes.

## Current step: "Review from Ferret" (plan `docs/superpowers/plans/2026-10-17-review-from-ferret.md`, POC mode: no tests)

Ledger with per-task evidence and rulings: `.superpowers/sdd/2026-10-17-review-from-ferret/progress.md` (git-ignored). **Tasks 1–12 complete, Task 13 remaining.** All of it is **uncommitted** in the working tree (user commits by hand).

What now works (verified with dev scripts, typecheck/build/suite green, 150 tests):
- **Scope engine** `src/server/scope.ts`: changes / commit / range / branch / PR → checkout (user repo or a Ferret worktree under `~/.review-app/worktrees/<repo>-<sha7>`), diff command, changed files, `ReviewSource`.
- **GitHub via `gh`** `src/server/github.ts` (status, prInfo, listPrs). `gh` logged in as michalmiszczuk (a second stale account makes `gh auth status` exit 1; status uses `gh api user`).
- **Headless runner** `src/server/claude-runner.ts`: spawns `claude -p … --output-format stream-json --verbose --permission-mode dontAsk --allowedTools <read-only list> --strict-mcp-config --mcp-config <this server>`, stdin closed, env without `ELECTRON_RUN_AS_NODE`/`CLAUDECODE`, `--model opus` (drafts `sonnet`; env `REVIEW_APP_MODEL`), cancel = taskkill tree, timeouts 15 min / 2 min. A `.cjs` `claudePath` runs through node (fake CLI `tests/fake-claude/claude.cjs`, modes ok/error/hang/submit; `REVIEW_APP_CLAUDE` env overrides the binary).
- **Prompts** `src/server/prompts.ts` (rules = §2–4 of `skills/ai-review/SKILL.md`; worktree scopes run with cwd = `~/.review-app/sandbox` and the worktree only in `--add-dir`, so a PR's CLAUDE.md/hooks are never loaded).
- **Jobs** `src/server/jobs.ts`: reviews one at a time, drafts in their own lane, `jobs.json` history, scope tokens for the chat, "nothing submitted" → empty review with a note, SSE `job-updated`.
- **MCP**: new `prepare_review_scope`; `submit_review` takes `jobId`/`scopeId` to attach `source` and the checkout.
- **API** (`src/server/api.ts`, options object `ApiOptions`): `/api/env`, `/api/repos`, `/api/repos/info|prs|commits`, `POST /api/jobs`, `/api/jobs/:id[/cancel]`, draft endpoints, `/api/pick-folder`, `/api/save-file`, `GET /api/reviews/:id/export`, `POST /api/reviews/import`; file endpoint marks changed lines vs the review's base.
- **Export/import** `src/shared/export.ts`, `src/server/import.ts`: Markdown with a ` ```json ferret-review ` block, local paths stripped; import opens at the reviewed commit (worktree) when the clone has it.
- **Skill** `skills/ai-review/SKILL.md`: `/ai-review`, paths, `HEAD~3..HEAD`, sha, branch, `#218`/URL via `prepare_review_scope`. (User must click **Update Claude** in the header to reinstall skills.)
- **UI**: **Review ▶** button → modal (`ReviewPanel.tsx`: Pull request / Commit / Changes tabs, repo picker + Browse…, PR list, commit list with shift-click ranges, branch-vs-base); job cards above the findings list (`JobCard.tsx`); source label in header/switcher; **Draft reply / Regenerate / Copy** on the card, **Draft all** in the header; **Export ▾** (Copy Markdown / Save .md… / Import review…) + drag-and-drop import; **Ask about this step** in step bubbles; snapshot hint on worktree reviews; Send to Claude uses the review's checkout folder.
- **Real run verified**: a headless `claude -p` review of commit 87dd1db produced review r_beb5ab (2 findings) end to end.

Dev helpers (all `npx tsx scripts/…`): `try-scope.ts`, `try-github.ts <repo> [pr]`, `try-runner.ts`, `try-jobs.ts`, `try-mcp-scope.ts`, `try-review.ts [--mode submit|ok|error|real] [--scope changes|older-commit|range]`, `try-export.ts`, `try-ui.ts` (preview server on :4478 with a running fake job; screenshot with `SCREENSHOT_URL=http://127.0.0.1:4478/?panel=review npm run screenshot -- out.png`).

## Task 13 (done except the manual E2E) and the final review

Done: worktree sweep (`JobManager.sweepWorktrees()`, at startup and after delete/clear; running jobs and chat scopes are protected; `scripts/try-sweep.ts`), README section, final fresh review (fable) + one fix pass. Fixes from the review: drafts and reviews on snapshots run from the sandbox with `--setting-sources user --strict-mcp-config` (a PR's hooks/CLAUDE.md/.mcp.json never load); imported revisions validated (sha head, safe base, https url) and `--end-of-options` on the gutter diff; snapshot reviews get the diff as a file in the sandbox and no shell; `JobManager.shutdown()` on quit; timeouts fail visibly; PR URL must match the clone's origin; old job cards hidden; Draft all counts failures; Send to Claude opens the snapshot folder; cancel aborts git fetch/worktree add. Deferred minors and all rulings are in the ledger (`Final:` lines).

2026-10-18: Send to Claude on PR/imported reviews now opens the **user's clone** (not the snapshot) and the Claude chat most recently used there (`src/server/claude-sessions.ts`, `GET /api/claude/session`); `get_pending_actions` returns the clone as `repoRoot` plus `reviewedAt`, and the apply-review skill offers `gh pr checkout` when HEAD differs. Header gem counts moved onto the severity chips. Review panel: a pasted PR URL starts without a repo picked (server finds the clone or asks for Browse…). Job cards show live progress (phase, files read / steps, activity feed).

**Still to do: manual E2E with the user** (restart the app: tray → Quit, `npm run desktop:dev`; click **Update Claude**): PR #218 of synergycodes/workflowbuilder from the panel; own latest commit; Draft reply + Draft all; Export → Import into a scratch `REVIEW_APP_HOME`; `/ai-review HEAD~3..HEAD` and `/ai-review #218` from the chat; delete a PR review → worktree gone; cancel a running review. Suggested commit message for the whole step: `Review from Ferret: PR/commit reviews, drafts, export/import`.

## After this step (agreed roadmap)

1. ~~Send to ClickUp~~ — built 2026-10-18 (pulled ahead at the user's request): Export ▾ → Send to ClickUp… picks a person (searchable member list) and a task; the .md is attached to the task (ClickUp's API cannot attach files to chat — the user chose this over a Doc link after trying one) + summary comment + a DM to the person linking to it. A Task tab does attach+comment only. Personal token in `~/.review-app/clickup.json` (OAuth deferred); `src/server/clickup.ts`, verified against a mock (`scripts/try-clickup.ts`); task flow user-verified for real, the DM-to-person variant still to be tried.
1b. ~~Whiteboard~~ — built 2026-10-19: Ferret draws reviews on dev.fast Whiteboard (panel select Off / Draw / Explain first + Export ▾), `src/server/whiteboard.ts` as an MCP client of Whiteboard's own server; "Explain first" = Claude authors the Whiteboard (headless, `buildExplainRun`, Whiteboard MCP tools), Ferret reads it back as review context, findings appended to the same document; drawing verified live on PR #217, explain pipeline verified with `scripts/try-explain.ts`. Also 2026-10-19: direct delivery of findings into a running Claude session ("to" picker; `deliver.ts` courier + `~/.claude/sessions` registry).
2. **In-app Claude chat** (replaces the VS Code round-trip for discussing findings/steps; same runner).
3. Later: Mac build, tests pass at the end of the POC, Bitbucket API, ClickUp OAuth "Connect" button when Ferret is distributed to the team (user decided 2026-10-18 to keep the pk_ token until then).

## Working agreements

- User commits by hand; suggest short one-line messages. Never run `git commit`.
- POC: no tests unless asked; keep the existing suite green; verify with typecheck, build, screenshots, scripts.
- The user works in the **VS Code Claude panel** only (not the CLI); channels aren't available there.
