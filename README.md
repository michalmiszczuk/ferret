# Ferret 🦦

Ferret out bugs: a local triage desk for AI code reviews. Claude Code sends findings in, you triage them (🔴 → 🟢, code with inline comments), and Claude fixes the ones you pick. In **Proposals** mode it works the other way round: Claude proposes a change as steps and you approve each one before anything is edited.

## Quick start (first time)

You need Windows, Node 20+, git, and [Claude Code](https://claude.com/claude-code) (`claude` on your PATH, used in VS Code or the terminal). Optional: the GitHub CLI `gh` (logged in with `gh auth login`) for pull requests; a ClickUp API token for *Send to ClickUp*; [Whiteboard](https://dev.fast) for drawing reviews.

1. `git clone` this repo, then `npm install` and `npm run desktop:dev`. Ferret opens (and lives in the tray; tray → **Quit** exits).
2. Click **Connect Claude** in the header (later **Update Claude** when the app has newer skills). This installs the skills `ai-review`, `apply-review`, `propose-changes`, `apply-proposal` into `~/.claude/skills` and registers Ferret's MCP server (`review-app`, http://127.0.0.1:4477/mcp) with Claude Code.
3. In an open Claude Code chat run `/mcp` and reconnect `review-app` (new chats pick it up by themselves).
4. Try it:
   - **Review**: in the chat, `/ai-review` (your uncommitted changes) or `/ai-review #218` (a PR); or click **Review ▶** in Ferret. Findings appear in Ferret; write a message on one and **Send to Claude**.
   - **Proposal**: in the chat, describe a change and add `/propose-changes`. Approve the steps in Ferret's **Proposals** mode (see below).

After pulling new code: restart Ferret (tray → Quit, `npm run desktop:dev`), click **Update Claude**, and `/mcp` → reconnect in open chats.

## Desktop app (Windows)

```
npm install
npm run icon          # once, generates build/icon.png
npm run desktop:dist  # builds release/review-app Setup <version>.exe
```

Run the installer (unsigned: SmartScreen → "More info" → "Run anyway"). Then:
- Tray icon → **Install Claude integration…** (installs the skills + registers the MCP server)
- Closing the window keeps review-app running in the tray; tray → **Quit** exits
- Tray → **Start with Windows** (off by default) keeps it ready for Claude
- If review-app isn't running, `/ai-review` launches it via `review-app://open`

Dev run: `npm run desktop:dev`. Screenshot of the running UI: `npm run screenshot -- out.png`. A dev run leaves `review-app://` pointing at the installed app; set `REVIEW_APP_DEV_PROTOCOL=1` to make the dev build own it instead.

If `desktop:dist` fails on Windows with "Cannot create symbolic link" (electron-builder's signing-tools archive contains macOS symlinks), either enable Windows Developer Mode, or extract `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<n>.7z` into `…\winCodeSign\winCodeSign-2.6.0` with `node_modules\7zip-bin\win\x64\7za.exe x` (the two macOS link errors are harmless).

## Terminal version

### Install (once)

```
npm install
npm run build
npm link            # puts `review-app` on your PATH
review-app setup    # installs the ai-review, apply-review, propose-changes, apply-proposal skills, registers the MCP server
```

### Use

1. Start the app: `review-app`, then open http://127.0.0.1:4477
2. In Claude Code (VS Code): `/ai-review` (uncommitted changes) or `/ai-review src/auth/` (files or folders)
3. Triage in the app: `j`/`k` move · `d` dismiss · write a message and **Send to Claude**
4. Claude gets `/apply-review r_… f… <your message>` in VS Code, fixes or answers, and the finding turns ✅

Reviews are stored in `~/.review-app/reviews/` (override with `REVIEW_APP_HOME`).

### Send a finding straight into a running chat

The **to** picker next to *Send to Claude* lists every running Claude Code session (any VS Code window or terminal), e.g. `⚡ workflowbuilder-5c · workflowbuilder — auto`. Pick one and Send delivers the finding into that chat directly: Claude there receives it as a message and handles it, no Enter needed. Delivery is done by a tiny headless Claude run (Haiku, a few seconds; override with `REVIEW_APP_MESSENGER_MODEL`). The default "VS Code" option keeps the old behaviour: open the chat with the command pre-filled and you press Enter.

### Let Claude listen for findings you send

Instead of typing `/apply-review` after each **Send to Claude**, ask Claude Code to watch Ferret: "start a Monitor that listens to Ferret". It polls the read-only endpoint `GET http://127.0.0.1:4477/api/sent`, which lists the findings currently waiting for Claude (`{ "actions": [{ reviewId, findingId, severity, title, file, lineStart, message, sentAt }] }`). Filter with `?sessionId=<Claude session id>` (reviews started by `/ai-review` in that session) or `?reviewId=r_…`; with no filter it lists every review, which is what you want for reviews started from **Review ▶** in Ferret.

The Monitor command Claude runs (bash; each printed line becomes a notification in the chat, and Claude then calls `get_pending_actions` and handles it like `/apply-review`):

```sh
prev=""
while true; do
  out=$(curl -s "http://127.0.0.1:4477/api/sent?sessionId=<session id>" || true)
  cur=$(printf '%s' "$out" | grep -o '"reviewId":"[^"]*","findingId":"[^"]*"' \
    | sed 's/"reviewId":"\([^"]*\)","findingId":"\([^"]*\)"/\1:\2/')
  for id in $cur; do
    case " $prev " in *" $id "*) ;; *) echo "Ferret sent $id — run get_pending_actions";; esac
  done
  prev=$(echo $cur)
  sleep 2
done
```

- A finding leaves the list once Claude picks it up (`get_pending_actions` marks it as being fixed), so a finding you send again later is reported again.
- A Monitor stops after 30 minutes at most; ask Claude to re-arm it, or to stop it with TaskStop.
- A cron job (`/loop 2m /apply-review`) also works, but wakes Claude every 2 minutes even when nothing was sent; the Monitor only speaks when there is something to do.

## Review a PR or commit from Ferret

Click **Review ▶** in the header. Ferret runs Claude Code headless (read-only: it can read files and run `git diff/show/log`, nothing else) on the scope you pick and the findings land in a new review:

- **Pull request** — paste a GitHub PR URL or pick one from the repo's open PRs. Needs the GitHub CLI: install `gh` and run `gh auth login`. Ferret needs a local clone of the repo (it never clones by itself); pasting a URL auto-selects the clone whose `origin` matches. Bitbucket PRs: review the PR's source branch from the **Commit** tab (branch vs base).
- **Commit** — one commit, a range (shift-click two commits), or a branch compared with the default branch.
- **Changes** — the repo's uncommitted changes.

Two optional fields give the reviewer context: **ClickUp task** (Ferret reads its description, comments and attachment names as the requirements; needs the ClickUp token from *Send to ClickUp*) and **Notes for the reviewer** (free text: what the change is for, what to worry about, what to ignore).

A Claude chat can also hand a review to Ferret with what it knows: say "let Ferret review it" (or `/ai-review #218 in ferret`) and the chat calls Ferret's `start_review` tool with the scope plus notes from the conversation, then Ferret runs the review in the background.

Reviews run one at a time; cards above the findings list show progress and let you cancel. The reviewed code is shown as it was at that commit, with the changed lines marked in the gutter. Same scopes from the chat: `/ai-review HEAD~3..HEAD`, `/ai-review 3f2a1c9`, `/ai-review feature/x`, `/ai-review #218` (or a PR URL).

**Replies for the author.** On a finding, **Draft reply** asks Claude for a short review comment you can copy into GitHub/Bitbucket; **Draft all** in the header drafts every open finding. Ferret never posts anything.

**Share a review.** **Export ▾** → *Copy Markdown* or *Save .md…* writes a readable Markdown file that also carries the review data. A friend with Ferret drops it onto their window (or *Import review…*) and, if their clone has that commit, gets the same findings on the same code.

**Send to ClickUp.** **Export ▾** → *Send to ClickUp…* sends the review to a teammate: search the people in your Workspace, pick one, pick a task to hold the file (usually the PR's task — ClickUp's API only uploads files to tasks, not to chat), and Ferret attaches the .md there, posts a summary comment on the task, and DMs the person your editable message with a link to it. The *Task* tab does just the attach + comment, no DM. The last five people/tasks are remembered. Needs your personal API token once (ClickUp → Settings → Apps → API Token); it is stored in `~/.review-app/clickup.json` and never leaves your machine except to api.clickup.com.

**Whiteboard.** Ferret can draw reviews on [Whiteboard](https://dev.fast), the open-source canvas for explaining code. To connect it:
1. Install Whiteboard from https://dev.fast/install and open it.
2. On Whiteboard's welcome screen choose **Connect Claude Code**. This registers Whiteboard's MCP server with Claude Code (user scope). Check with `claude mcp get whiteboard`: it should say *Connected*.
3. Restart Ferret. It finds that registration in `~/.claude.json` and uses the same server; nothing else to configure. Whiteboard doesn't need to be open: Ferret starts it when it draws.

The Review panel then gets a *Whiteboard* choice:
- *Draw the findings when done* — Ferret draws the finished review on a Whiteboard canvas pinned to the same PR or commits: a section per severity, each finding as a callout with a code peek on its lines, multi-place paths as flow diagrams.
- *Explain first* — Claude first writes the Whiteboard for the change (what/why, design diagram, implementation walk, every claim linked to lines), Ferret reads that document back and gives it to the reviewer as the map of the change, and the findings are added to the same Whiteboard. About twice the time and usage of a plain review; best on large or unfamiliar PRs. If a Whiteboard of that PR already exists (e.g. drawn from a chat), it is reused and no explanation pass runs.

**Export ▾ → Draw on Whiteboard / Open / Redraw** works for any review (redraw after triage to carry over dismissals). Ferret talks to Whiteboard through its MCP server, using the registration in `~/.claude.json`.

**Snapshots.** PRs and older commits are checked out into Ferret-owned git worktrees under `~/.review-app/worktrees/` (`git worktree add --detach`). Your own checkout is never touched, but your repo's `.git/worktrees/` gains an entry per snapshot; Ferret removes the snapshot when its last review is deleted and sweeps unused ones at startup. Headless runs on a snapshot use `~/.review-app/sandbox` as the working directory, so a PR's own `CLAUDE.md` and hooks are never loaded.

**Models.** The Review panel has a model picker; the default is Claude Opus 5.5 (`claude-opus-5-5`), drafts use Sonnet 5.5, and delivery into chats uses Haiku 5.5. Opus 5.5 and Fable 5.1 need Claude Code 2.1.280 or newer for headless runs (`claude update`); Sonnet and Haiku work on older versions. Override with `REVIEW_APP_MODEL` / `REVIEW_APP_DRAFT_MODEL` / `REVIEW_APP_MESSENGER_MODEL`; `REVIEW_APP_CLAUDE` points at a different `claude` executable.

## Proposal mode: approve a change step by step

The header's **Reviews | Proposals** switch opens the second mode. Here a Claude Code chat does not edit files straight away: it **proposes** the change as ordered steps, you review each one in Ferret, and Claude applies only what you approved. Ferret never writes to your repo; the chat does, in your clone.

**Before the first proposal**
- Click **Update Claude** in Ferret's header once (installs the `propose-changes` and `apply-proposal` skills), then in the chat run `/mcp` and reconnect `review-app` so it sees the proposal tools.
- Switch that chat to **auto-accept edits** for the proposal. Otherwise VS Code asks again for every step you already approved in Ferret.

**1. Ask for a proposal.** In the chat, describe the task and add `/propose-changes` (or say "propose this in Ferret" / "step by step in Ferret"). Claude reads the files and sends the steps; the proposal pops up in Ferret (the window comes to the front with a notification) and the chat waits. Each step has a title, what / why, the file and lines, the exact current text and its replacement (or a command such as `npm test` to run), `dependsOn` when it only makes sense after another step, and **notes**: short explanations attached to functions and blocks, shown in violet inside the diff right under the code they explain.

**2. Review a step.** The left list is the timeline; the right side is the open step: what / why, then the diff.
- **Full file / Changes only** above the diff. *Full file* (default) shows the whole current file with line numbers, the change in place and scrolled into view; *Changes only* shows just the edited lines. The choice is remembered.
- The **comment box** at the bottom goes with your decision: a change you want ("remove the comment"), a question, or a reason to decline.
- The bottom bar stays in place while the diff scrolls.

**3. Decide.** Two ways, mix them freely:
- **Approve & next ↓** (`n`) marks the step approved in Ferret only, with the comment if you typed one, and opens the next step that needs a decision. Nothing is sent yet. Collect as many as you like, then **Send N approvals ▶** delivers them to the chat in one message. A green bar lists what is waiting (`s3 ✎` = with a comment); **Clear** (`Esc`) empties it. Reopen an approved step to edit its comment and approve again.
- **Ctrl+click** steps in the list to add or remove them from the approvals, **Shift+click** to add a range.
- **Accept now ▶** (`a`) sends one step immediately. **Ask** (`Ctrl+Enter` in the box, `q` focuses it) sends your question; Claude answers in the step's thread. **Decline** (`d`) with an optional reason; Claude skips the step or comes back with a revised one. **Accept all remaining** takes every pending step that isn't blocked.
- Keys work outside the comment box: `j` / `k` move between steps.

**4. Claude applies and reports back.** Decisions arrive in the proposing chat as `/apply-proposal <proposal> <step> accept|decline|ask …`, `… accept-steps s1,s2,s4` or `… accept-all`, delivered straight into it (the same courier as *Send to Claude*). Claude applies accepted edits exactly as proposed, with your comment's change if you wrote one, runs command steps, and reports each one: the step turns **Applied** with a one-line note, a command's output shows under the step, a question gets an answer in the thread, a revised step comes back as *pending* with the previous version kept (*N previous versions*). If the chat is not running, the decision is still recorded and Ferret offers **Copy the command** to paste anywhere.

**Blocked and stale steps.** A step is *blocked* (`after s1 · blocked`) until the steps it depends on are applied; in a batch, a step whose prerequisite is approved in the same batch goes through, because Claude applies them in order. A step is *stale* when the file no longer contains its original text (someone edited it, or an earlier step changed those lines): Accept is off and **Ask Claude to refresh** asks the chat to re-read the file and revise the step. Steps that can't be accepted in a batch are skipped and the toast says why.

**A step that failed** (Claude reports `Failed` with the reason) can be accepted again to retry or declined to drop it.

Proposals are stored in `~/.review-app/proposals/`, survive restarts, and are done when every step is applied, declined or skipped; **Delete** in the header removes the open one, and done proposals fold into *Done proposals* under the list.

## Develop

```
npm run dev:server   # API + MCP on :4477
npm run dev:ui       # Vite on :5173 (proxies /api and /mcp)
npm test
npm run typecheck
npm run build        # UI (dist/ui) + server/desktop bundles; the desktop app serves dist/ui
npm run seed         # submit a demo review of this repo
```

Dev scripts (`npx tsx scripts/<name>`), none of them touch your real data (scratch `REVIEW_APP_HOME`) or spend Claude usage (fake `claude` in `tests/fake-claude/claude.cjs`):

| Script | What it shows |
|---|---|
| `try-ui.ts` | Preview server on :4478 with a running review job (`?panel=review` opens the Review panel) |
| `try-proposal-ui.ts` | Preview server on :4480 with seeded proposals: an active one, a stale step, a done one; decisions go to a printing spy instead of a chat |
| `try-proposal.ts` | Proposal store, MCP tools and HTTP API end to end; prints `ok: …` per check |
| `try-review.ts`, `try-jobs.ts`, `try-runner.ts` | Headless review runs (`--mode submit|ok|error|real`) |
| `try-start-review.ts` | A chat handing a review to Ferret (`start_review`) with notes |
| `try-deliver.ts`, `try-session.ts` | Delivery into a running Claude session; finding the latest chat of a folder |
| `try-clickup.ts`, `try-whiteboard.ts`, `try-explain.ts` | ClickUp (mock server), Whiteboard drawing, explain-first |

Screenshot a preview: `SCREENSHOT_URL=http://127.0.0.1:4480/ npm run screenshot -- out.png` (the folder of `out.png` must exist).

Project status, decisions and the roadmap: `docs/STATUS.md`; designs and plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`.
