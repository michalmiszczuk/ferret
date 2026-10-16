import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { FileResponse, StoreEvent } from "../shared/api-types";
import { toSummary } from "../shared/findings";
import { findingPatchSchema } from "../shared/schema";
import type { ClaudeIntegration } from "./claude";
import { changedLines, PathError, readRepoFile, reanchor, splitLines } from "./files";
import { NotFoundError, type ReviewStore } from "./store";
import { findVsCodeTheme } from "./vscode-theme";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function createApiRouter(store: ReviewStore, claude?: ClaudeIntegration): Router {
  const r = Router();
  r.use(express.json({ limit: "1mb" }));

  if (claude) {
    r.get(
      "/claude/status",
      wrap(async (_req, res) => res.json(await claude.status())),
    );
    // Changes the user's Claude Code config, so only the app's own fetch (JSON) may trigger it —
    // a cross-site form/text post from some web page is refused.
    r.post(
      "/claude/connect",
      wrap(async (req, res) => {
        if (!req.is("application/json")) return res.status(415).json({ error: "Expected application/json" });
        res.json(await claude.connect());
      }),
    );
  }

  // The user's current VS Code color theme, so code looks the same as in their editor. 204 = use the default.
  r.get(
    "/code-theme",
    wrap(async (_req, res) => {
      const theme = await findVsCodeTheme();
      if (!theme) return res.status(204).end();
      res.json(theme);
    }),
  );

  r.get("/reviews", (_req, res) => {
    res.json(store.list().map(toSummary));
  });

  r.get("/reviews/:id", (req, res) => {
    const review = store.get(req.params.id);
    if (!review) return void res.status(404).json({ error: "Review not found" });
    res.json(review);
  });

  r.patch(
    "/reviews/:id/findings/:fid",
    wrap(async (req, res) => {
      const parsed = findingPatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      try {
        res.json(await store.updateFinding(req.params.id, req.params.fid, parsed.data));
      } catch (err) {
        if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.get(
    "/reviews/:id/file",
    wrap(async (req, res) => {
      const review = store.get(req.params.id);
      if (!review) return res.status(404).json({ error: "Review not found" });
      const rel = typeof req.query.path === "string" ? req.query.path : "";
      if (!rel) return res.status(400).json({ error: "Missing ?path=" });
      try {
        const file = await readRepoFile(review.repoRoot, rel);
        if (!file.exists) return res.json({ exists: false } satisfies FileResponse);
        const anchors = Object.fromEntries(
          review.findings.filter((f) => f.file === rel).map((f) => [f.id, reanchor(file.content, f)]),
        );
        const body: FileResponse = {
          exists: true,
          content: file.content,
          changedLines: await changedLines(review.repoRoot, rel, splitLines(file.content).length),
          anchors,
        };
        res.json(body);
      } catch (err) {
        if (err instanceof PathError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const onChange = (e: StoreEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    store.on("change", onChange);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      store.off("change", onChange);
    });
  });

  return r;
}
