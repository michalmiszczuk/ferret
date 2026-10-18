---
name: apply-review
description: Handle findings the user sent from review-app. Use when the user runs /apply-review (e.g. `/apply-review r_8f3k2a f2 keep the public API`) or says "apply my review decisions".
---

# Handle findings sent from review-app

The arguments are: an optional review id (`r_…`), optional finding ids (`f1 f2 …`), then an optional free-text **message** from the user. Example: `/apply-review r_8f3k2a f2 fix it but keep the public API`.

1. Call the `review-app` MCP tool `get_pending_actions` with `reviewId` (if given) and `findingIds` (if given).
2. If the `review-app` tool is unavailable or the connection fails, the app is probably not running. Launch it (Windows PowerShell: `Start-Process review-app://open`; Windows Git Bash: `cmd //c start "" review-app://open`; macOS: `open review-app://open`), wait about 5 seconds and call `get_pending_actions` once more. If it still fails, tell the user to run `/mcp`, reconnect `review-app`, and tell you to retry.
3. If `actions` is empty, tell the user there is nothing sent from review-app and stop.
3b. If the result has `reviewedAt` (the review was made on a specific commit: a pull request, a commit or an imported review), check that `repoRoot` is on that code before editing: `git -C "<repoRoot>" rev-parse HEAD`. If it differs from `reviewedAt.head`, do **not** edit yet. Tell the user which branch/PR the review was made on (`reviewedAt.label`) and offer the checkout (`gh pr checkout <pr>` for a PR, `git checkout <branch>` otherwise); if the working tree is dirty say so. Only continue when the user says to (or when they already told you in the message to switch branches), or when they say to apply on the current branch anyway.
4. For each action, in the order given:
   - The user's instruction is the **message** typed after the ids, or else the action's `myNote`. **It overrides everything else.** No message means: fix the problem described in `body`.
   - Open `file` around `lineStart..lineEnd` (paths are relative to `repoRoot`). If the action has `steps`, the problem spans several places: each step is `{file, lineStart, lineEnd, snippet, note}` on the path from where it starts to where it bites; read them all before changing anything.
     - `anchor: "lost"`: the code moved or changed. Locate it from `snippet` and the description. If you cannot find it, skip it.
     - `anchor: "file-missing"`: skip it.
   - Do what the user asked:
     - **A change** (or no message): make the **smallest change** that resolves the problem, following `suggestion` unless the user said otherwise. Do not fix unrelated things. Then call `mark_done` with `outcome: "fixed"` and a one-sentence `note` saying what you changed.
     - **A question or a "don't change anything"**: answer it, change no code, and call `mark_done` with `outcome: "skipped"` and your answer as `note` (short; it is shown on the finding in the app).
     - **Cannot do it**: `mark_done` with `outcome: "skipped"` and a one-sentence reason.
5. Finish with a short summary, one line per finding.

Do not commit. The user reviews the changes and commits.
