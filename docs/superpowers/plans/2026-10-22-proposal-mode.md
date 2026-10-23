# Proposal Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude session proposes a task as ordered edit steps; Ferret shows each step (what/why, before/after diff) with Accept / Ask / Decline, delivers every decision straight into that session, and tracks what got applied. Ferret never writes to the repo.

**Architecture:** A new top-level object `proposal` with its own store (`~/.review-app/proposals/*.json`), six MCP tools for the proposing session, an API + SSE surface for the UI, decisions delivered through the existing courier (`deliverToSession`) to the session resolved from `sessionId` via `listLiveSessions()`, and a "Proposals" mode in the UI (header segmented switch) with a step timeline and a step card that reuses the review code view's highlighter.

**Tech Stack:** as the app: Node 20 / TypeScript ESM, Express 4, `@modelcontextprotocol/sdk` (server + client for scripts), Zod 3, React 18 + Vite, Shiki via `src/ui/highlight.ts`.

**Spec:** `docs/superpowers/specs/2026-10-22-proposal-mode-design.md`

## Global Constraints

- "Ferret never writes to the repo." Nothing in this plan calls `fs.write*` on a user checkout; Ferret only reads files for the stale check.
- POC mode (user's standing instruction): no new unit tests; verification is typecheck, build, dev scripts under `scripts/`, screenshots. The existing suite (150) stays green.
- The user commits by hand; commit steps below are "suggest the message", never `git commit`.
- Reuse, don't fork: `deliverToSession` / `listLiveSessions` for delivery, `reanchor` for the stale check, `highlight()` for diffs, the `.modal`/`.card`/`.segmented` styles.
- Caps (spec §6, owner's values): ≤ 50 steps per `propose_changes`/`add_steps` call, `before`/`after` ≤ 20 000 chars each, `what`/`why` ≤ 1 000 chars, `mark_step.note` ≤ 4 000 chars, Ask question ≤ 2 000 chars.

## Review Focus

Checked by dev scripts and screenshots (POC mode), not unit tests:

1. **`before` no longer matches the file** (stale): the step shows *stale*, Accept is disabled, "Ask Claude to refresh" sends a canned Ask. Task 2 script edits the temp repo file and expects `stale: true`; Task 7 screenshot of the stale banner.
2. **A declined or failed prerequisite**: dependents stay blocked with a visible reason, never silently acceptable. Task 2 script: decline step 1 → step 2 `blocked: true` with `blockedBy: ["s1"]`.
3. **The proposing session is gone** when a decision is made: the API answers `delivered: false` with a reason, the UI shows the "to" picker / copy fallback, the decision is still recorded. Task 4 script with no matching session.
4. **Oversize or malformed proposals** (51 steps, 25 KB `before`, duplicate `stepId`, `dependsOn` on an unknown step): `propose_changes` fails with a message naming the field; nothing is stored. Task 3 script.
5. **Keyboard scope**: `a`/`d`/`q` act only in Proposals mode and only outside text boxes; `j`/`k` move within the current mode's list. Task 7 manual check in the preview.

---

## File Structure

- `src/shared/proposal.ts` — zod schemas + types (`Proposal`, `Step`, `ProposedStepInput`, `proposeChangesShape`, statuses, caps).
- `src/shared/diff.ts` — `diffLines(a, b)` line diff for the card (pure).
- `src/shared/api-types.ts` — `StoreEvent` gains proposal events; `ProposalSummary`, `StepView`.
- `src/server/proposal-store.ts` — `ProposalStore` (persist, decisions, outcomes, views with stale/blocked).
- `src/server/mcp.ts` — six tools.
- `src/server/api.ts` — `/api/proposals*` routes, delivery, SSE relay.
- `src/server/index.ts` — construct the store, wire deps, expose on `RunningServer`.
- `skills/propose-changes/SKILL.md`, `skills/apply-proposal/SKILL.md`, `src/cli/setup.ts` (`SKILL_NAMES`).
- `src/ui/api.ts`, `src/ui/App.tsx`, `src/ui/components/Header.tsx` — mode switch + state.
- `src/ui/components/ProposalPane.tsx`, `StepCard.tsx`, `DiffView.tsx`, `src/ui/styles.css`.
- `scripts/try-proposal.ts` (store + MCP + API + delivery), `scripts/try-proposal-ui.ts` (preview on :4480).
- `README.md`, `docs/STATUS.md`.

---

### Task 1: Shared model

**Files:** Create `src/shared/proposal.ts`, `src/shared/diff.ts`. Modify `src/shared/api-types.ts`.

**Interfaces (Produces):**
- `STEP_KINDS = ["edit","create","delete","command"]`, `STEP_STATUSES = ["pending","asked","accepted","applied","declined","revised","failed","skipped"]`.
- `proposedStepInputSchema`: `{ stepId: string(1..40, /^[\w.-]+$/), title: string(1..200), file?: string, lineStart?: int≥1, lineEnd?: int≥1, kind: StepKind, what: string(1..1000), why: string(1..1000), before?: string(≤20000), after?: string(≤20000), command?: string(≤2000), dependsOn?: string[] }` with refinements: `edit` needs `before` and `after`; `create` needs `after`; `delete` needs `before`; `command` needs `command`.
- `stepSchema = proposedStepInputSchema + { status: StepStatus, thread: { by: "you"|"claude", kind: "ask"|"answer"|"decline"|"note"|"accept", text: string, at: string }[], revisions: { what, why, before?, after?, at }[], decision?: { kind: "accept"|"decline"|"ask", text?: string, at: string, taken: boolean }, outcome?: { kind: "applied"|"failed"|"skipped", note?: string, at: string } }`.
- `proposalSchema = { id: string, createdAt, updatedAt, repoRoot: string, sessionId?: string, projectDir?: string, task: { title: string(1..200), context?: string(≤4000), planRef?: string }, status: "active"|"done", steps: Step[] }`.
- `proposeChangesShape` (raw zod shape for the MCP tool): `{ repoRoot, sessionId?, projectDir?, task, steps: array(proposedStepInputSchema).min(1).max(50) }`; `addStepsShape`, `reviseStepShape`, `answerShape`, `markStepShape`, `decisionShape` likewise.
- `diffLines(a: string, b: string): { type: "same" | "add" | "del"; text: string }[]` — LCS over lines (Myers not needed; O(n·m) DP is fine for 20 KB).
- `api-types`: `StoreEvent |= { type: "proposal-created" | "proposal-updated" | "proposal-deleted"; proposalId: string }`; `ProposalSummary = { id, title, status, createdAt, progress: { applied: number; total: number } }`; `StepView = Step & { stale: boolean; blocked: boolean; blockedBy: string[] }`.

- [ ] **Step 1:** Write the schemas and `diffLines`.
- [ ] **Step 2:** Verify: `npm run typecheck` → clean. `npx tsx -e` is unreliable on this machine, so add the schema checks to Task 2's script instead.

### Task 2: ProposalStore

**Files:** Create `src/server/proposal-store.ts`, `scripts/try-proposal.ts` (part 1).

**Interfaces (Produces):** `class ProposalStore extends EventEmitter` — `constructor(dir: string, log: (m: string) => void)`, `load()`, `list(): Proposal[]` (newest first), `get(id)`, `create(input: ProposeChangesInput): Promise<Proposal>` (id `p_` + 6 hex; rejects duplicate `stepId` and unknown `dependsOn` with `Error("step <id>: dependsOn <x> is not a step of this proposal")`), `addSteps(id, steps, afterStepId?)`, `reviseStep(id, stepId, patch)` (pushes previous `{what,why,before,after}` to `revisions`, applies patch, status `pending`, clears `decision`), `answer(id, stepId, answer)` (thread `{by:"claude", kind:"answer"}`, `asked`→`pending`), `decide(id, stepId, d: { kind; text? }): Promise<Step>` (status `accepted|declined|asked`, `decision.taken=false`, thread entry; throws on `blocked` or on status `applied`), `acceptAllRemaining(id): Promise<Step[]>` (every `pending`, not blocked, not stale-checked here), `takeDecisions(id?): Promise<{ proposal; steps: Step[] }>` (steps with `decision.taken === false` → set `taken = true`; mirrors `takePending`), `markStep(id, stepId, outcome, note?)` (status `applied|failed|skipped`, outcome stored, thread `{by:"claude", kind:"note"}` when note; proposal `status = "done"` when every step is applied/declined/skipped), `delete(id)`, `views(proposal, readFile: (rel: string) => Promise<string | null>): Promise<StepView[]>` (stale = kind edit/delete, status pending/asked/revised, and `reanchor(content, { lineStart, lineEnd, snippet: before }).anchor === "lost"` or file missing; blocked = some `dependsOn` step not `applied`, `blockedBy` = those ids). Persist like `ReviewStore` (tmp + rename, write queue); emits `change` with the proposal events.

- [ ] **Step 1:** Implement the store.
- [ ] **Step 2:** `scripts/try-proposal.ts` part 1: temp git repo with `src/a.ts` (3 lines) → `create` with steps s1 (edit a.ts, exact `before`), s2 (`dependsOn: ["s1"]`), s3 (command) → `views`: s1 `stale:false`, s2 `blocked:true blockedBy:["s1"]` → `decide(s1, accept)` → `takeDecisions` returns s1 once, second call returns none → `markStep(s1, applied)` → s2 `blocked:false` → `decide(s1' …)` rejected after applied → `decide(s2, decline)` → `markStep(s3, skipped)` → proposal `done` → modify `src/a.ts` and re-`views`: a fresh pending edit step on it shows `stale:true`; duplicate stepId and unknown dependsOn throw with the field named.
- [ ] **Step 3:** Run it. Expected: each line printed as `ok: <check>`; typecheck clean.

### Task 3: MCP tools

**Files:** Modify `src/server/mcp.ts` (`McpDeps.proposals?: ProposalStore`), `scripts/try-proposal.ts` (part 2).

**Interfaces (Consumes):** Task 2 store. **Produces:** tools `propose_changes` → `ok({ proposalId, url: \`${base}/p/${id}\`, steps: n, message })`; `add_steps`; `revise_step`; `answer_proposal`; `get_proposal_decisions({ proposalId? })` → `ok({ proposalId, repoRoot, decisions: [{ stepId, decision, text?, title, file, lineStart, lineEnd, kind, before, after, command, stale }] , message? })` (uses `store.views` for `stale`); `mark_step`. `repoRoot` through `normalizeRepoRoot`. Descriptions tell Claude: `before` must be the exact current text; decisions arrive as `/apply-proposal …` messages.

- [ ] **Step 1:** Register the six tools; `mountMcp` test list grows to eleven names — update `tests/server/mcp.test.ts` ("lists the five tools" → the new count and names) so the suite stays green.
- [ ] **Step 2:** Script part 2 (MCP `Client` over `/mcp` like `scripts/try-start-review.ts`): `propose_changes` → id; `get_proposal_decisions` → empty + message; store `decide` → `get_proposal_decisions` returns it with `stale:false`; `mark_step`; `revise_step` keeps a revision; `answer_proposal` moves `asked`→`pending`; 51 steps → error naming `steps`; 25 KB `before` → error naming `before`.
- [ ] **Step 3:** Run script + `npm test`. Expected: all `ok:` lines; suite green.

### Task 4: API, delivery, wiring

**Files:** Modify `src/server/api.ts` (`ApiOptions.proposals?: ProposalStore`), `src/server/index.ts` (`ServerOptions.deliver?` override for scripts; `RunningServer.proposals`), `scripts/try-proposal.ts` (part 3).

**Interfaces (Produces):** `GET /api/proposals` → `ProposalSummary[]`; `GET /api/proposals/:id` → `Proposal & { steps: StepView[] }` (views read files under `repoRoot` with the existing `readRepoFile`); `POST /api/proposals/:id/steps/:sid/decide` `{ kind: "accept"|"decline"|"ask", text? }` → `{ step: StepView, delivered: boolean, agent?: string, reason?: string }`; `POST /api/proposals/:id/accept-all` → `{ steps, delivered, agent?, reason? }`; `POST /api/proposals/:id/steps/:sid/refresh` → an Ask with the canned text "The file changed since you proposed this step. Please re-read it and revise the step."; `DELETE /api/proposals/:id`. Delivery: `agent = (await listLiveSessions()).find(s => s.sessionId === proposal.sessionId)?.name`; message `/apply-proposal <id> <stepId> <kind>[ <text one line>]` or `/apply-proposal <id> accept-all`; prefixed "Ferret: a decision on your proposal. Please handle it now: …"; no agent → `delivered:false, reason:"The proposing Claude session isn't running"`; courier error → `delivered:false, reason`. SSE: relay `proposals.on("change")` next to the store and jobs. `index.ts`: `new ProposalStore(path.join(home, "proposals"), log)`, `await proposals.load()`, pass to `mountMcp` deps and `createApiRouter`.

- [ ] **Step 1:** Routes, relay, wiring.
- [ ] **Step 2:** Script part 3: `startServer({ deliver: spy })` → decide accept via HTTP with a fake registry entry? The registry is `~/.claude/sessions`; the script instead passes `sessionId` of a live session when one exists, else expects `delivered:false` with the reason. Also: `accept-all` makes exactly one spy call; SSE emits `proposal-updated`; 415 on non-JSON.
- [ ] **Step 3:** Run; typecheck. Expected: `ok:` lines; `delivered` reflects whether a live session matched.

### Task 5: Skills

**Files:** Create `skills/propose-changes/SKILL.md`, `skills/apply-proposal/SKILL.md`. Modify `src/cli/setup.ts` (`SKILL_NAMES` += both).

- [ ] **Step 1:** `propose-changes`: when the user says "propose this in Ferret" / "step by step in Ferret": read every file you will touch, build steps (one concern each, exact `before` copied from the file, `after` the full replacement, `dependsOn` for order, `command` steps for tests/builds), call `propose_changes` with `sessionId: "${CLAUDE_SESSION_ID}"`, `projectDir: "${CLAUDE_PROJECT_DIR}"`, reply with one line (`Proposal p_x: N steps → <url>`), then wait; decisions arrive as `/apply-proposal …` messages. Note on double approval: ask the user to switch this session to auto-accept edits for the proposal, otherwise each accepted edit prompts again in VS Code.
- [ ] **Step 2:** `apply-proposal`: on `/apply-proposal <id> <stepId> accept|decline|ask <text>` or `accept-all`: `get_proposal_decisions`; for each: accept → apply with Edit using `before`→`after` exactly (create/delete via Write/remove), run `command` steps and put the output in `mark_step.note`, `mark_step applied|failed`; decline → `mark_step skipped` or `revise_step` + say so; ask → `answer_proposal`, revise if the answer changes the edit. A stale decision → re-read, `revise_step`. One line per step in the reply.
- [ ] **Step 3:** Verify: `npx vitest run tests/cli` green; `npm run typecheck`.

### Task 6: UI data + mode switch

**Files:** Modify `src/ui/api.ts`, `src/ui/App.tsx`, `src/ui/components/Header.tsx`, `src/ui/styles.css`; create `scripts/try-proposal-ui.ts`.

**Interfaces (Produces):** `fetchProposals()`, `fetchProposal(id)`, `decideStep(id, sid, kind, text?)`, `acceptAll(id)`, `refreshStep(id, sid)`, `deleteProposal(id)`; App state `mode: "reviews" | "proposals"` (localStorage `ferret.mode`), `proposals: ProposalSummary[]`, `proposalId`, `proposal` (full), `stepId`; SSE: `proposal-created` → load list, switch `mode` to proposals and open it (mirrors review pop-in); `proposal-updated` for the open one → refetch. Header: segmented `Reviews | Proposals` left of the switcher; the switcher lists the current mode's items; Review ▶, Draft all, Export hide in Proposals mode; Delete deletes the open proposal there. `scripts/try-proposal-ui.ts`: scratch home on :4480 with one seeded proposal over this repo (3 steps: edit with exact `before` from `package.json`, a dependent edit, a command), one with a stale step, one done.

- [ ] **Step 1:** Implement; keep the existing review behaviour unchanged in Reviews mode.
- [ ] **Step 2:** Verify: typecheck, `npm run build`, start the preview, `SCREENSHOT_URL=http://127.0.0.1:4480/ npm run screenshot -- mode.png` shows the segmented switch with Proposals active and the proposal listed in the switcher.

### Task 7: UI proposal pane

**Files:** Create `src/ui/components/ProposalPane.tsx`, `StepCard.tsx`, `DiffView.tsx`; modify `src/ui/App.tsx`, `src/ui/styles.css`.

**Interfaces (Consumes):** Task 6 state; `diffLines`; `highlight()`; `vscodeUrl(repoRoot, file, line)` from `src/shared/paths`.

- [ ] **Step 1:** `ProposalPane` (left): task header line (title, "4 / 9 applied"), timeline rows (status dot colour by status, "2b", title, chips: stale / blocked / asked), done proposals in a collapsed "Done" group.
- [ ] **Step 2:** `StepCard` (right): "Step 2b · title"; file path as Open in VS Code; what / why; `DiffView` (unified: `del` lines red tint, `add` green tint, `same` muted; tokens via `highlight()` per side, plain fallback); `command` steps show a `<pre>` and the output block from `outcome.note` (collapsible); dependsOn chip; stale banner with "Ask Claude to refresh"; thread (you/claude bubbles); actions: Accept (disabled when stale/blocked/applied), Ask (inline box, Ctrl+Enter), Decline (optional reason), Accept all remaining; status badge; revisions as "v2 (previous)" toggle.
- [ ] **Step 3:** Keys in `App.tsx`: in Proposals mode and outside inputs: `a` accept, `d` decline, `q` focus the ask box, `j`/`k` move; the review keys stay Reviews-only.
- [ ] **Step 4:** Decision feedback: toast "Delivered to <agent>" / "Recorded — <reason>. Copy the command?" with a Copy button (the `/apply-proposal …` text) when `delivered:false`.
- [ ] **Step 5:** Verify: screenshots of the timeline + an edit card with a diff, the stale card, a done summary; keys checked by hand in the preview.

### Task 8: Docs, E2E, final review

**Files:** Modify `README.md`, `docs/STATUS.md`.

- [ ] **Step 1:** README "Proposal mode" section (what it is, the two skills, the double-approval note, keys); STATUS.
- [ ] **Step 2:** Verify: typecheck, build, `npm test` green.
- [ ] **Step 3:** Manual E2E with the user and the workflowbuilder session: Update Claude; "propose the next task step by step in Ferret" → proposal appears; Accept one, Ask one, Decline one; see applied/answer/skip come back; stale by editing a file first; Accept all remaining; done summary.
- [ ] **Step 4:** Final whole-branch review (fresh reviewer, most capable model) + one fix pass; suggested commit message `Proposal mode: step-by-step change approval`.
