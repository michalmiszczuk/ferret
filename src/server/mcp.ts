import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { countBySeverity } from "../shared/findings";
import { parsePrUrl, parseRange, sourceLabel } from "../shared/git-parse";
import { MODEL_ID } from "../shared/models";
import { addStepsShape, answerShape, markStepShape, proposeChangesShape, reviseStepShape } from "../shared/proposal";
import { submitReviewShape } from "../shared/schema";
import { parseTaskRef } from "./clickup";
import { anchorFinding, normalizeRepoRoot } from "./files";
import type { JobManager } from "./jobs";
import { repoFileReader, type ProposalStore } from "./proposal-store";
import { resolveScope as defaultResolveScope, type PrInfoFn, type ScopeInput } from "./scope";
import type { ReviewStore } from "./store";

export interface McpDeps {
  jobs?: JobManager;
  resolveScope?: typeof defaultResolveScope;
  prInfo?: PrInfoFn;
  worktreesDir?: string;
  proposals?: ProposalStore;
}

const prepareScopeInput = z.union([
  z.literal("changes"),
  z.object({ commit: z.string().min(1) }),
  z.object({ range: z.string().min(1).describe("a..b") }),
  z.object({ branch: z.string().min(1), base: z.string().optional() }),
  z.object({ pr: z.union([z.number().int(), z.string().min(1)]).describe("PR number or URL") }),
]);

function toScopeInput(repo: string, scope: z.infer<typeof prepareScopeInput>): ScopeInput {
  if (scope === "changes") return { type: "changes", repo };
  if ("commit" in scope) return { type: "commit", repo, sha: scope.commit };
  if ("range" in scope) {
    const r = parseRange(scope.range);
    if (!r) throw new Error(`range must look like a..b, got "${scope.range}"`);
    return { type: "range", repo, from: r.from, to: r.to };
  }
  if ("branch" in scope) return { type: "branch", repo, branch: scope.branch, base: scope.base };
  const pr = scope.pr;
  if (typeof pr === "number") return { type: "pr", repo, number: pr };
  const parsed = parsePrUrl(pr) ?? (/^#?\d+$/.test(pr.trim()) ? { number: Number(pr.trim().replace("#", "")) } : null);
  if (!parsed) throw new Error(`pr must be a number or a PR URL, got "${pr}"`);
  return { type: "pr", repo, number: parsed.number };
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
  isError: true,
});

export function buildMcpServer(store: ReviewStore, getBaseUrl: () => string, deps: McpDeps = {}): McpServer {
  const server = new McpServer({ name: "review-app", version: "0.1.0" });

  server.registerTool(
    "submit_review",
    {
      title: "Submit code review",
      description:
        "Save a finished code review so the user can triage it in Ferret (review-app). Call once at the end of a review with ALL findings. Returns the review id and the URL to show the user.",
      inputSchema: submitReviewShape,
    },
    async (input) => {
      try {
        const { jobId, scopeId, ...rest } = input;
        // A review started from Ferret (jobId) or prepared with prepare_review_scope (scopeId) carries its source;
        // its code is served from the scope's checkout.
        const scope = jobId ? deps.jobs?.scopeForJob(jobId) : scopeId ? deps.jobs?.takeScope(scopeId) : undefined;
        if ((jobId || scopeId) && !scope) throw new Error(`unknown ${jobId ? "job" : "scope"} id; call prepare_review_scope again or omit it`);
        const review = await store.create(
          { ...rest, repoRoot: scope ? scope.checkout : await normalizeRepoRoot(input.repoRoot) },
          scope ? { source: scope.source, jobId, task: jobId ? deps.jobs?.taskForJob(jobId) : undefined } : {},
        );
        if (jobId) deps.jobs?.reviewSubmitted(jobId, review.id);
        return ok({ reviewId: review.id, url: `${getBaseUrl()}/r/${review.id}`, counts: countBySeverity(review.findings) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "prepare_review_scope",
    {
      title: "Prepare a review scope",
      description:
        "Prepares what to review in a repo: uncommitted changes, a commit, a range (a..b), a branch (vs its base) or a pull request (number or URL). Fetches/snapshots as needed and returns where the code is (checkout), the diff command, the changed files and a scopeId to pass to submit_review. Use this for every /ai-review that names a commit, range, branch or PR.",
      inputSchema: {
        repo: z.string().min(1).describe("Absolute path of the local clone"),
        scope: prepareScopeInput,
      },
    },
    async ({ repo, scope }) => {
      try {
        const input = toScopeInput(await normalizeRepoRoot(repo), scope);
        const resolved = await (deps.resolveScope ?? defaultResolveScope)(input, {
          worktreesDir: deps.worktreesDir ?? deps.jobs?.worktreesDir ?? "",
          prInfo: deps.prInfo,
        });
        const scopeId = deps.jobs?.registerScope(resolved);
        return ok({
          scopeId,
          checkout: resolved.checkout,
          isWorktree: resolved.isWorktree,
          head: resolved.source.head,
          base: resolved.source.base,
          diffCommand: resolved.diffCommand,
          changedFiles: resolved.changedFiles,
          label: resolved.label,
          source: resolved.source,
          note: resolved.isWorktree
            ? `The code is a detached snapshot at ${resolved.checkout}; read files there and run git as \`git -C "${resolved.checkout}" …\`. Pass repoRoot: "${resolved.checkout}" and this scopeId to submit_review.`
            : `Review in place. Pass this scopeId to submit_review.`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "start_review",
    {
      title: "Hand a review to Ferret",
      description:
        "Queue a review that Ferret runs itself in the background (headless Claude), instead of reviewing in this chat. Pass what you know from this conversation in `notes` — what the change is for, what the user is worried about, decisions already made, things to ignore — so the reviewer starts with that context. Optionally a ClickUp task link whose description is read as the requirements. Returns the job id; findings appear in Ferret when done.",
      inputSchema: {
        repo: z.string().min(1).describe("Absolute path of the local clone"),
        scope: prepareScopeInput,
        notes: z.string().max(8000).optional().describe("Context for the reviewer from this conversation (markdown, a few paragraphs at most)"),
        task: z.string().max(300).optional().describe("ClickUp task link or id the change implements"),
        model: z.string().regex(MODEL_ID).optional().describe("Model id, e.g. claude-opus-5-5 (default) or claude-sonnet-5-5"),
        whiteboard: z.enum(["draw", "explain"]).optional().describe("Also draw on Whiteboard, or explain the change on Whiteboard first"),
      },
    },
    async ({ repo, scope, notes, task, model, whiteboard }) => {
      try {
        if (!deps.jobs) throw new Error("This Ferret build cannot run reviews itself");
        if (task && !parseTaskRef(task)) throw new Error("task must be a ClickUp task link (https://app.clickup.com/t/…) or a task id");
        const input = toScopeInput(await normalizeRepoRoot(repo), scope);
        const job = deps.jobs.startReview(input, model, { whiteboard, task, notes });
        return ok({ jobId: job.id, label: job.label, url: getBaseUrl(), message: "Queued in Ferret; the job card shows progress and the review opens there when done." });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_pending_actions",
    {
      title: "Get pending review actions",
      description:
        "Returns the findings the user sent to Claude from Ferret (with their message in myNote) and marks them as 'fixing'. Omit reviewId to use the most recent review; pass findingIds to take only those. After handling each one, call mark_done.",
      inputSchema: {
        reviewId: z.string().optional().describe("Review id, e.g. r_8f3k2a. Omit for the latest review."),
        findingIds: z.array(z.string()).optional().describe("Only these findings, e.g. [\"f2\"]. Omit for all sent findings."),
      },
    },
    async ({ reviewId, findingIds }) => {
      try {
        const { review, findings } = await store.takePending(reviewId, findingIds);
        const actions = await Promise.all(
          findings.map(async (f) => {
            const a = await anchorFinding(review.repoRoot, f);
            return {
              findingId: f.id,
              severity: f.severity,
              title: f.title,
              body: f.body,
              suggestion: f.suggestion,
              file: f.file,
              lineStart: a.lineStart,
              lineEnd: a.lineEnd,
              anchor: a.exists ? a.anchor : "file-missing",
              snippet: f.snippet,
              ...(f.steps ? { steps: f.steps } : {}),
              myNote: f.myNote,
            };
          }),
        );
        // Fixes go into the user's clone, never into a Ferret snapshot (a PR review's repoRoot is the snapshot).
        const src = review.source;
        return ok({
          reviewId: review.id,
          repoRoot: src?.repo ?? review.repoRoot,
          ...(src
            ? {
                reviewedAt: {
                  head: src.head,
                  ...(src.branch ? { branch: src.branch } : {}),
                  ...(src.kind === "pr" && src.number ? { pr: src.number } : {}),
                  label: sourceLabel(src),
                },
              }
            : {}),
          actions,
          ...(actions.length === 0
            ? { message: "Nothing pending. Ask the user to click 'Send to Claude' on a finding in Ferret first." }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "mark_done",
    {
      title: "Report a finding as handled",
      description: "Call after handling each pending action: outcome 'fixed' with a one-sentence note of what changed, or 'skipped' with why.",
      inputSchema: {
        reviewId: z.string(),
        findingId: z.string(),
        outcome: z.enum(["fixed", "skipped"]),
        note: z.string().min(1).describe("One sentence for the user"),
      },
    },
    async ({ reviewId, findingId, outcome, note }) => {
      try {
        await store.updateFinding(reviewId, findingId, { status: outcome, resolution: note });
        return ok({ ok: true, remaining: store.countFixing(reviewId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerProposalTools(server, getBaseUrl, deps);
  return server;
}

/** Proposal mode: a session proposes a task as steps; the user decides in Ferret; decisions come back as chat messages. */
function registerProposalTools(server: McpServer, getBaseUrl: () => string, deps: McpDeps): void {
  const proposals = () => {
    if (!deps.proposals) throw new Error("This Ferret build has no proposal mode");
    return deps.proposals;
  };
  const stepSummary = (s: { stepId: string; status: string; title: string }) => ({ stepId: s.stepId, status: s.status, title: s.title });

  server.registerTool(
    "propose_changes",
    {
      title: "Propose changes step by step",
      description:
        "Before editing files for a task, propose the change as ordered steps so the user approves each one in Ferret. Each edit/delete step's `before` must be the EXACT current text of the file (copy it, whitespace included) and `after` the full replacement; `lineStart`/`lineEnd` say where `before` is now. Use `dependsOn` when a step only makes sense after another is applied. Add `notes` (`{ at, text }`) for every function/method/non-obvious block in `after`: they are shown inside the diff at that line, so the user understands the code where it is. Do NOT edit anything yet: the user's decisions arrive in this chat as `/apply-proposal <proposalId> <stepId> accept|decline|ask …` messages (or `accept-all`); apply only accepted steps, then call mark_step. If you lose a message, call get_proposal_decisions.",
      inputSchema: proposeChangesShape,
    },
    async (input) => {
      try {
        const repoRoot = await normalizeRepoRoot(input.repoRoot);
        const p = await proposals().create({ ...input, repoRoot });
        return ok({
          proposalId: p.id,
          url: `${getBaseUrl()}/p/${p.id}`,
          steps: p.steps.length,
          message: `Proposed ${p.steps.length} step(s). Wait for the user's decisions (they come as /apply-proposal messages); do not apply anything yet.`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "add_steps",
    {
      title: "Add steps to a proposal",
      description: "Append (or insert after a step) more steps to an existing proposal, e.g. follow-ups the user asked for. Same rules as propose_changes.",
      inputSchema: addStepsShape,
    },
    async ({ proposalId, steps, afterStepId }) => {
      try {
        const p = await proposals().addSteps(proposalId, steps, afterStepId);
        return ok({ proposalId, steps: p.steps.map(stepSummary) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "revise_step",
    {
      title: "Revise a proposed step",
      description:
        "Replace a step's what/why/before/after after the user asked a question or declined it with a reason. The previous version is kept; the step goes back to pending for a new decision.",
      inputSchema: reviseStepShape,
    },
    async ({ proposalId, stepId, ...patch }) => {
      try {
        const s = await proposals().reviseStep(proposalId, stepId, patch);
        return ok({ proposalId, step: stepSummary(s), revisions: s.revisions.length, message: "The step is pending again; wait for the user's decision." });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "answer_proposal",
    {
      title: "Answer a question about a step",
      description: "Reply to the user's question on a step (decision `ask`) without changing the step. The step goes back to pending so the user can decide.",
      inputSchema: answerShape,
    },
    async ({ proposalId, stepId, answer }) => {
      try {
        const s = await proposals().answer(proposalId, stepId, answer);
        return ok({ proposalId, step: stepSummary(s) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_proposal_decisions",
    {
      title: "Get the user's decisions on a proposal",
      description:
        "Returns decisions not yet handed over (accept / decline / ask with the user's text) and marks them as taken. Decisions normally arrive in this chat as /apply-proposal messages; use this when one was missed or to check. `stale: true` means the file no longer contains the step's `before` text: re-read the file and revise_step before applying.",
      inputSchema: {
        proposalId: z.string().optional().describe("Proposal id, e.g. p_8f3k2a. Omit for the latest proposal."),
      },
    },
    async ({ proposalId }) => {
      try {
        const store = proposals();
        const { proposal, steps } = await store.takeDecisions(proposalId);
        const views = await store.views(proposal, repoFileReader(proposal.repoRoot));
        const stale = new Map(views.map((v) => [v.stepId, v.stale]));
        const decisions = steps.map((s) => ({
          stepId: s.stepId,
          decision: s.decision!.kind,
          ...(s.decision!.text ? { text: s.decision!.text } : {}),
          title: s.title,
          kind: s.kind,
          file: s.file,
          lineStart: s.lineStart,
          lineEnd: s.lineEnd,
          before: s.before,
          after: s.after,
          command: s.command,
          stale: stale.get(s.stepId) ?? false,
        }));
        return ok({
          proposalId: proposal.id,
          repoRoot: proposal.repoRoot,
          decisions,
          ...(decisions.length === 0 ? { message: "No new decisions. The user decides each step in Ferret; wait for /apply-proposal messages." } : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "mark_step",
    {
      title: "Report a step's outcome",
      description:
        "Call after handling each accepted step: `applied` with a one-sentence note of what changed, `failed` with why, or `skipped` with why. For command steps put the trimmed output in `note`.",
      inputSchema: markStepShape,
    },
    async ({ proposalId, stepId, outcome, note }) => {
      try {
        const store = proposals();
        await store.markStep(proposalId, stepId, outcome, note);
        const p = store.get(proposalId)!;
        const remaining = p.steps.filter((s) => s.status === "accepted").length;
        return ok({ ok: true, remaining, proposalStatus: p.status });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** Stateless Streamable HTTP: a fresh MCP server + transport per POST, as in the SDK's stateless example. */
export function mountMcp(app: express.Express, store: ReviewStore, getBaseUrl: () => string, deps: McpDeps = {}): void {
  app.post("/mcp", express.json({ limit: "5mb" }), async (req, res) => {
    const server = buildMcpServer(store, getBaseUrl, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("review-app: MCP request failed", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  const notAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
