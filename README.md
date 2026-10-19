# Ferret 🦦

Ferret out bugs: a local triage desk for AI code reviews. Claude Code sends findings in, you triage them (🔴 → 🟢, code with inline comments), and Claude fixes the ones you pick.

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
review-app setup    # installs /ai-review + /apply-review skills, registers the MCP server
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

Reviews run one at a time; cards above the findings list show progress and let you cancel. The reviewed code is shown as it was at that commit, with the changed lines marked in the gutter. Same scopes from the chat: `/ai-review HEAD~3..HEAD`, `/ai-review 3f2a1c9`, `/ai-review feature/x`, `/ai-review #218` (or a PR URL).

**Replies for the author.** On a finding, **Draft reply** asks Claude for a short review comment you can copy into GitHub/Bitbucket; **Draft all** in the header drafts every open finding. Ferret never posts anything.

**Share a review.** **Export ▾** → *Copy Markdown* or *Save .md…* writes a readable Markdown file that also carries the review data. A friend with Ferret drops it onto their window (or *Import review…*) and, if their clone has that commit, gets the same findings on the same code.

**Send to ClickUp.** **Export ▾** → *Send to ClickUp…* sends the review to a teammate: search the people in your Workspace, pick one, pick a task to hold the file (usually the PR's task — ClickUp's API only uploads files to tasks, not to chat), and Ferret attaches the .md there, posts a summary comment on the task, and DMs the person your editable message with a link to it. The *Task* tab does just the attach + comment, no DM. The last five people/tasks are remembered. Needs your personal API token once (ClickUp → Settings → Apps → API Token); it is stored in `~/.review-app/clickup.json` and never leaves your machine except to api.clickup.com.

**Snapshots.** PRs and older commits are checked out into Ferret-owned git worktrees under `~/.review-app/worktrees/` (`git worktree add --detach`). Your own checkout is never touched, but your repo's `.git/worktrees/` gains an entry per snapshot; Ferret removes the snapshot when its last review is deleted and sweeps unused ones at startup. Headless runs on a snapshot use `~/.review-app/sandbox` as the working directory, so a PR's own `CLAUDE.md` and hooks are never loaded.

Models: `opus` for reviews, `sonnet` for drafts; override with `REVIEW_APP_MODEL` / `REVIEW_APP_DRAFT_MODEL`. `REVIEW_APP_CLAUDE` points at a different `claude` executable.

## Develop

```
npm run dev:server   # API + MCP on :4477
npm run dev:ui       # Vite on :5173 (proxies /api and /mcp)
npm test
npm run seed         # submit a demo review of this repo
```
