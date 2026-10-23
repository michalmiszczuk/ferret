# Ferret: Proposal mode (step-by-step change approval) — design

Requested by Michał on 2026-10-22, drafted by his workflowbuilder Claude session, adopted here with the owner's calls. Status: **awaiting Michał's approval**.

## 1. Problem

Michał implements plan tasks with Claude Code one edit at a time: Claude explains the edit, Michał approves, Claude writes. Today the explanation lives in chat, the diff in VS Code's Manual-mode Accept/Reject view (no description, no step number, no overview), and a question about one specific change has to be typed in chat, detached from the diff.

He wants one place where every proposed edit is a visual step: what and why, a before/after diff, and **Accept / Ask / Decline**, plus the list of all steps of the task with their status.

## 2. Boundary

**Ferret never writes to the repo.** Ferret shows proposals and collects decisions; the Claude session that proposed the edits applies the accepted ones itself. This keeps Claude Code's permission model, file-state tracking and VS Code integration intact. Ferret stays a viewer and decider.

## 3. Flow

1. A Claude session calls `propose_changes` with a task title, optional context, and an ordered list of steps. It passes its `sessionId` and `projectDir` (as `submit_review` does).
2. Ferret opens the proposal: header (title, context, "step 3 of 7"), a step timeline on the left, the selected step's card on the right.
3. Michał decides per step:
   - **Accept** → status `accepted`, delivered to the session. Claude applies it and reports `applied` (or `failed` with a reason when the edit no longer matches).
   - **Ask** → inline question box; delivered; status `asked`. Claude answers with `answer_proposal` (shown as a thread on the card; status back to `pending`) and may `revise_step` with a new diff (previous versions kept, viewable).
   - **Decline** → optional reason; delivered; status `declined`. Claude may skip it or send a revised replacement.
   - **Accept all remaining** → one batched delivery for mechanical batches.
4. `dependsOn`: a dependent step is blocked (Accept disabled, chip "after step 2a") until its prerequisite is `applied`; a declined prerequisite flags its dependents.
5. When every step is `applied`, `declined` or `skipped`, the proposal is `done`: summary (applied N, declined M, questions asked) and the proposal moves to history.

## 4. Step content

| Field | Shown as |
|---|---|
| `index`, `title` | "Step 2b · Import setControlledTheme" |
| `file`, `lineStart`..`lineEnd` | clickable path (Open in VS Code) |
| `what`, `why` | one or two sentences each |
| `before` / `after` | unified diff with syntax highlighting (the review code view's highlighter); `create` shows `after` only, `delete` shows `before` only |
| `kind` | `edit` \| `create` \| `delete` \| `command` (a command block, no diff; its output appears on the card after `mark_step`) |
| `dependsOn` | chip |
| `status` | pending / asked / accepted / applied / declined / revised / failed / skipped, plus **stale** (the file no longer contains `before`) and **blocked** (unmet `dependsOn`) |
| thread | questions, answers, Claude's notes, decline reasons |

## 5. Decisions on the draft's open questions

1. **Own top-level object.** `proposal` lives next to reviews (`~/.review-app/proposals/*.json`), with its own lifecycle, events (`proposal-created`, `proposal-updated`) and UI. Michał asked for a header **mode switch**: a segmented control "Reviews | Proposals" (same style as the status filter), each mode with its own list, switcher entries and keyboard map. The step card reuses the code view and highlighter.
2. **Delivery is immediate and direct.** Every decision is delivered into the proposing session through Ferret's courier (the direct-delivery path built for findings: a headless run that calls SendMessage, the target resolved from `sessionId` via the `~/.claude/sessions` registry). No pre-fill, no Enter, no Monitor. Fallbacks: the "to" picker when the session isn't found (pick another or the VS Code pre-fill), and `get_proposal_decisions` for sessions that pull. "Accept all remaining" is one delivery.
3. **Persisted** like reviews; survives restarts. On open and on every refresh Ferret re-checks each pending step's `before` against the file (reusing the snippet re-anchoring) and marks it **stale**; the card offers "Ask Claude to refresh" (an Ask with a canned question).
4. **Command output** comes back through `mark_step`'s `note` (capped at a few KB), shown in a collapsible block. No new tool.

## 6. MCP tools

- `propose_changes({ repoRoot, sessionId, projectDir, task: { title, context?, planRef? }, steps })` → `{ proposalId, url }`. `Step = { stepId, title, file?, lineStart?, lineEnd?, kind, what, why, before?, after?, command?, dependsOn? }`. `before` must be the exact current text.
- `add_steps({ proposalId, steps, afterStepId? })`.
- `revise_step({ proposalId, stepId, what?, why?, before?, after? })` (history kept; status → `revised`, then `pending`).
- `answer_proposal({ proposalId, stepId, answer })`.
- `get_proposal_decisions({ proposalId? })` → steps with a new decision (`accepted`, `declined` + reason, `asked` + question), marked in progress. Mirrors `get_pending_actions`.
- `mark_step({ proposalId, stepId, outcome: 'applied' | 'failed' | 'skipped', note? })`.

Delivered message shape: `/apply-proposal <proposalId> <stepId> accept|decline|ask [text]`; batched: `/apply-proposal <proposalId> accept-all`. The `apply-proposal` skill: call `get_proposal_decisions`, apply accepted edits with Edit, answer questions, `mark_step` each. A "propose changes" section in the same skill tells Claude how to write good steps (only files just read, exact `before`, one concern per step, `dependsOn` for ordering).

## 7. Known risks

- **Double approval.** After Accept in Ferret, the session's Edit tool still prompts in VS Code unless that session auto-accepts edits. Ferret cannot change that; the skill tells the session to run proposals with edits auto-accepted, or Michał accepts twice. (Open with the workflowbuilder session.)
- **`before` drift.** Covered by the stale state; the skill revises instead of forcing.
- **Courier cost.** One small headless run per decision (seconds, pennies). "Accept all remaining" batches.

## 8. Out of scope for v1

Ferret applying edits; multi-file atomic steps (split with `dependsOn`); editing the proposed code inside Ferret; proposals from headless Ferret runs (the proposer is always an interactive session).

## 9. UI

- Header: segmented **Reviews | Proposals**; the switcher lists the current mode's items; Review ▶ hides in Proposals mode.
- Left pane (Proposals): the active proposal's timeline — status dot, index, title, blocked/stale markers; done proposals below, collapsed.
- Right pane: the task header (title, context, progress "4 / 9 applied"), then the step card: what/why, diff, dependsOn chip, thread, actions (Accept · Ask · Decline · Accept all remaining), Open in VS Code.
- Keys: `a` accept, `d` decline, `q` ask, `j`/`k` move. Same visual language as findings (cards, chips, gems not used — status dots instead).

## 10. Verification (POC, no tests)

Dev script with a fake proposing session (creates a proposal over this repo, decisions delivered to a fake courier, `mark_step` round trip); screenshots of the timeline and a card; E2E with the workflowbuilder session on a real task.
