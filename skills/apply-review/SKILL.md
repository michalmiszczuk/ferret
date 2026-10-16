---
name: apply-review
description: Apply the fixes the user selected in review-app. Use when the user runs /apply-review (optionally with a review id like r_8f3k2a) or says "apply my review decisions".
---

# Apply review decisions from review-app

1. Call the `review-app` MCP tool `get_pending_actions`. Pass `reviewId` if the user gave one (e.g. `/apply-review r_8f3k2a`); otherwise omit it.
2. If the `review-app` tool is unavailable or the connection fails, the app is probably not running. Launch it (Windows PowerShell: `Start-Process review-app://open`; Windows Git Bash: `cmd //c start "" review-app://open`; macOS: `open review-app://open`), wait about 5 seconds and call `get_pending_actions` once more. If it still fails, tell the user to run `/mcp`, reconnect `review-app`, and tell you to retry.
3. If `actions` is empty, tell the user there is nothing marked for fixing and stop.
4. For each action, in the order given:
   - Open `file` around `lineStart..lineEnd` (paths are relative to `repoRoot`).
     - `anchor: "lost"`: the code moved or changed. Locate it from `snippet` and the description. If you cannot find it, skip it.
     - `anchor: "file-missing"`: skip it.
   - Make the **smallest change** that resolves the problem described in `body`. Follow `suggestion` unless `myNote` says otherwise. **`myNote` is the user's instruction and overrides everything else.** Do not fix unrelated things.
   - Call `mark_done` right away with `outcome: "fixed"` and a one-sentence `note` saying what you changed, or `outcome: "skipped"` and a one-sentence reason.
5. Finish with a short summary: "Fixed N, skipped M", plus one line per finding.

Do not commit. The user reviews the changes and commits.
