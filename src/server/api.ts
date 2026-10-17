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

export function createApiRouter(
  store: ReviewStore,
  claude?: ClaudeIntegration,
  openExternal?: (url: string) => Promise<void>,
): Router {
  const r = Router();
  r.use(express.json({ limit: "1mb" }));

  if (openExternal) {
    // Opens vscode:// links from the server side: a page can only launch external apps right after a click,
    // and "focus the window, wait, then open Claude" takes longer than that. JSON-only + vscode:// only.
    r.post(
      "/open-vscode",
      wrap(async (req, res) => {
        if (!req.is("application/json")) return res.status(415).json({ error: "Expected application/json" });
        const urls = (req.body as { urls?: unknown }).urls;
        // Only the two link shapes the UI builds: open a folder/file, or open the Claude panel.
        const allowed = /^vscode:\/\/(file\/|anthropic\.claude-code\/open(\?|$))/;
        if (!Array.isArray(urls) || urls.length === 0 || urls.length > 3 || !urls.every((u) => typeof u === "string" && allowed.test(u))) {
          return res.status(400).json({ error: "urls must be 1-3 vscode://file/… or vscode://anthropic.claude-code/open links" });
        }
        for (let i = 0; i < urls.length; i++) {
          await openExternal(urls[i]);
          if (i < urls.length - 1) await new Promise((r) => setTimeout(r, 1200)); // let VS Code switch windows
        }
        res.json({ ok: true });
      }),
    );
  }

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

  // Read-only: findings the user clicked "Send to Claude" on that Claude hasn't picked up yet (status
  // fix_requested). A watcher in a Claude session polls this and wakes the chat; it does NOT change state
  // (get_pending_actions does that). Filter by the session that made the review, and optionally by review.
  r.get("/sent", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const reviewId = typeof req.query.reviewId === "string" ? req.query.reviewId : undefined;
    const actions = store
      .list()
      .filter((rv) => (!sessionId || rv.sessionId === sessionId) && (!reviewId || rv.id === reviewId))
      .flatMap((rv) =>
        rv.findings
          .filter((f) => f.status === "fix_requested")
          .map((f) => ({
            reviewId: rv.id,
            findingId: f.id,
            severity: f.severity,
            title: f.title,
            file: f.file,
            lineStart: f.lineStart,
            message: f.myNote ?? "",
            sentAt: f.updatedAt,
          })),
      );
    res.json({ actions });
  });

  r.get("/reviews", (_req, res) => {
    res.json(store.list().map(toSummary));
  });

  r.get("/reviews/:id", (req, res) => {
    const review = store.get(req.params.id);
    if (!review) return void res.status(404).json({ error: "Review not found" });
    res.json(review);
  });

  // DELETE is never a "simple" cross-site request, so a web page can't trigger these without CORS (which we don't allow).
  r.delete(
    "/reviews",
    wrap(async (_req, res) => res.json({ deleted: await store.clear() })),
  );

  r.delete(
    "/reviews/:id",
    wrap(async (req, res) => {
      try {
        await store.delete(req.params.id);
        res.json({ deleted: 1 });
      } catch (err) {
        if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
        throw err;
      }
    }),
  );

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
        // Findings anchor under their id; path steps under "<findingId>#<stepIndex>".
        const anchors: Record<string, ReturnType<typeof reanchor>> = {};
        for (const f of review.findings) {
          if (f.file === rel) anchors[f.id] = reanchor(file.content, f);
          f.steps?.forEach((s, i) => {
            if (s.file === rel) anchors[`${f.id}#${i}`] = reanchor(file.content, s);
          });
        }
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
