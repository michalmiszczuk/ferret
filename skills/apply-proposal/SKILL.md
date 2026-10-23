---
name: apply-proposal
description: Handle the user's decisions on a proposal made with propose-changes in Ferret (review-app). Use when a message starts with /apply-proposal (e.g. `/apply-proposal p_8f3k2a s2 accept`, `… s3 ask why not a map?`, `… accept-all`) or the user says "apply my proposal decisions".
---

# Handle decisions on a proposal (Ferret / review-app)

The message is `/apply-proposal <proposalId> <stepId> accept|decline|ask [text]`, `/apply-proposal <proposalId> accept-steps s1,s2,s4` (a batch the user approved together) or `/apply-proposal <proposalId> accept-all`. Batches are handled exactly like single decisions, in the order `get_proposal_decisions` returns them. It may be prefixed with "Ferret: a decision on your proposal. Please handle it now:" (it was delivered by Ferret). Handle it **now**, in this turn, without asking the user to confirm again.

1. Call the `review-app` MCP tool `get_proposal_decisions` with `proposalId`. It returns every decision not yet handed over (the message is one of them; others may have piled up) with the step's `kind`, `file`, `lineStart`/`lineEnd`, `before`, `after`, `command`, the decision (`accept`, `decline`, `ask`), the user's `text` and `stale`.
2. If the `review-app` tool is unavailable or the connection fails, the app is probably not running. Launch it (Windows PowerShell: `Start-Process review-app://open`; Windows Git Bash: `cmd //c start "" review-app://open`; macOS: `open review-app://open`), wait about 5 seconds and call it once more. If it still fails, tell the user to run `/mcp`, reconnect `review-app`, and tell you to retry.
3. If `decisions` is empty, say there is nothing new and stop.
4. For each decision, in the order given (files are relative to `repoRoot`):
   - **`accept`**
     - `stale: true`: the file changed since you proposed the step. Re-read it, work out the new `before`/`after`, call `revise_step` with them and say so. The user decides again; do not apply.
     - `kind: "edit"`: apply it with the Edit tool, `old_string` = `before`, `new_string` = `after`, exactly. If Edit cannot find `before`, treat the step as stale (above).
     - `kind: "create"`: write the file with `after`. `kind: "delete"`: remove `before` (or the file, when `before` is the whole file).
     - `kind: "command"`: run `command` from `repoRoot`; trim the output to what matters (the summary lines, the first errors).
     - Then `mark_step({ proposalId, stepId, outcome: "applied", note })` with a one-sentence `note` of what changed; for a command, the trimmed output as `note`. If it failed, `outcome: "failed"` and why; when you can see the fix, also `revise_step` with the corrected version, otherwise the user retries (accept again) or declines the failed step in Ferret. If the user's `text` asks for a variation ("accept but keep the old name"), do that variation and say so in `note`.
   - **`decline`**: do not apply. If `text` explains what they want instead and you can do it, call `revise_step` with the new version (the step goes back to pending). Otherwise `mark_step` with `outcome: "skipped"` and a short `note`. Declining a step other steps depend on leaves them blocked: say which, and revise them if they still make sense.
   - **`ask`**: answer the question with `answer_proposal({ proposalId, stepId, answer })` — short, concrete, it is shown on the step card. If the answer changes the edit, call `revise_step` instead (an answer in `what`/`why` plus the new code). Change no code.
5. Reply with one line per step (`s2 applied: …`, `s3 answered`, `s4 skipped: …`). Nothing else: the user is in Ferret.

Apply only what was accepted, exactly as proposed. Do not fix unrelated things, do not commit.
