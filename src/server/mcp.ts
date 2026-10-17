import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { countBySeverity } from "../shared/findings";
import { submitReviewShape } from "../shared/schema";
import { anchorFinding, normalizeRepoRoot } from "./files";
import type { ReviewStore } from "./store";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
  isError: true,
});

export function buildMcpServer(store: ReviewStore, getBaseUrl: () => string): McpServer {
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
        const review = await store.create({ ...input, repoRoot: await normalizeRepoRoot(input.repoRoot) });
        return ok({ reviewId: review.id, url: `${getBaseUrl()}/r/${review.id}`, counts: countBySeverity(review.findings) });
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
        return ok({
          reviewId: review.id,
          repoRoot: review.repoRoot,
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
export function mountMcp(app: express.Express, store: ReviewStore, getBaseUrl: () => string): void {
  app.post("/mcp", express.json({ limit: "5mb" }), async (req, res) => {
    const server = buildMcpServer(store, getBaseUrl);
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
