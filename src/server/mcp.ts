import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { countBySeverity } from "../shared/findings";
import { parsePrUrl, parseRange, sourceLabel } from "../shared/git-parse";
import { submitReviewShape } from "../shared/schema";
import { anchorFinding, normalizeRepoRoot } from "./files";
import type { JobManager } from "./jobs";
import { resolveScope as defaultResolveScope, type PrInfoFn, type ScopeInput } from "./scope";
import type { ReviewStore } from "./store";

export interface McpDeps {
  jobs?: JobManager;
  resolveScope?: typeof defaultResolveScope;
  prInfo?: PrInfoFn;
  worktreesDir?: string;
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
          scope ? { source: scope.source, jobId } : {},
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

  return server;
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
