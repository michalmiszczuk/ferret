import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { EnvStatus, FileResponse, StoreEvent } from "../shared/api-types";
import { countBySeverity, toSummary } from "../shared/findings";
import { originMatches, ownerRepoFromOrigin, parsePrUrl } from "../shared/git-parse";
import { MODEL_ID } from "../shared/models";
import { findingPatchSchema } from "../shared/schema";
import type { ClaudeIntegration } from "./claude";
import { latestSession, listLiveSessions } from "./claude-sessions";
import { DeliverError } from "./deliver";
import { WhiteboardError, type WhiteboardService } from "./whiteboard";
import { ClickUpError, parseTaskRef, type ClickUpService } from "./clickup";
import { changedLines, changedLinesBetween, PathError, readRepoFile, reanchor, splitLines } from "./files";
import { GH_UNAVAILABLE, GithubError, type Github } from "./github";
import type { JobManager } from "./jobs";
import { exportReview, parseExport } from "../shared/export";
import { importReview } from "./import";
import { acceptAllCommand, acceptStepsCommand, decisionCommand, MAX_QUESTION, decisionSchema, proposalProgress, type Proposal } from "../shared/proposal";
import { repoFileReader, type ProposalStore } from "./proposal-store";
import { defaultBranch, headSha, isGitRepo, listBranches, listCommits, originUrl, repoNameOf, ScopeError, type ScopeInput } from "./scope";
import { NotFoundError, type ReviewStore } from "./store";
import { findVsCodeTheme } from "./vscode-theme";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export interface ApiOptions {
  claude?: ClaudeIntegration;
  openExternal?: (url: string) => Promise<void>;
  jobs?: JobManager;
  github?: Github;
  pickFolder?: () => Promise<string | null>;
  saveFile?: (suggestedName: string, content: string) => Promise<string | null>;
  claudeInstalled?: () => Promise<{ installed: boolean; version?: string }>;
  clickup?: ClickUpService;
  /** Delivers a message into a running Claude Code session by its agent name (built in index.ts). */
  deliver?: (agent: string, text: string) => Promise<void>;
  whiteboard?: WhiteboardService;
  proposals?: ProposalStore;
}

export function createApiRouter(store: ReviewStore, opts: ApiOptions = {}): Router {
  const { claude, openExternal, jobs, github, pickFolder, saveFile, claudeInstalled, clickup, deliver, whiteboard, proposals } = opts;
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
  if (whiteboard) {
    const wb = whiteboard;
    r.get(
      "/whiteboard/status",
      wrap(async (_req, res) => res.json(await wb.status())),
    );
    // Draw (or re-draw) a review on Whiteboard and open it there.
    r.post(
      "/reviews/:id/whiteboard",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        const review = store.get(req.params.id);
        if (!review) return res.status(404).json({ error: "Review not found" });
        const redraw = Boolean((req.body as { redraw?: boolean }).redraw);
        try {
          if (review.whiteboard && !redraw) {
            await wb.open(review.whiteboard.sessionId);
            return res.json({ sessionId: review.whiteboard.sessionId, opened: true });
          }
          const { sessionId } = await wb.publish(review);
          await store.setWhiteboard(review.id, { sessionId, at: new Date().toISOString() });
          res.json({ sessionId, opened: true });
        } catch (err) {
          if (err instanceof WhiteboardError) return res.status(502).json({ error: err.message });
          throw err;
        }
      }),
    );
  }

  // Running Claude Code sessions (VS Code windows / terminals) that can receive a finding directly.
  r.get(
    "/claude/agents",
    wrap(async (_req, res) => res.json({ agents: await listLiveSessions(), canDeliver: Boolean(deliver) })),
  );

  if (deliver) {
    r.post(
      "/claude/deliver",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        const { agent, text } = req.body as { agent?: unknown; text?: unknown };
        if (typeof agent !== "string" || typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "agent and text required" });
        const live = await listLiveSessions();
        if (!live.some((s) => s.name === agent)) return res.status(404).json({ error: `No running Claude session named "${agent}" — refresh the list` });
        try {
          await deliver(agent, text);
          res.json({ ok: true });
        } catch (err) {
          if (err instanceof DeliverError) return res.status(502).json({ error: err.message });
          throw err;
        }
      }),
    );
  }

  // The chat the user most recently used in a folder (for Send to Claude on reviews that didn't come from a chat).
  r.get(
    "/claude/session",
    wrap(async (req, res) => {
      const dir = typeof req.query.dir === "string" ? req.query.dir : "";
      if (!dir) return res.status(400).json({ error: "dir is required" });
      res.json(await latestSession(dir));
    }),
  );

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
    wrap(async (_req, res) => {
      const deleted = await store.clear();
      await jobs?.sweepWorktrees();
      res.json({ deleted });
    }),
  );

  r.delete(
    "/reviews/:id",
    wrap(async (req, res) => {
      try {
        const review = store.get(req.params.id);
        await store.delete(req.params.id);
        if (review?.source?.worktree) await jobs?.sweepWorktrees();
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
        // Reviews of a commit/PR mark what that change touched (base…head); plain reviews mark changes vs HEAD.
        const total = splitLines(file.content).length;
        const src = review.source;
        const body: FileResponse = {
          exists: true,
          content: file.content,
          changedLines:
            src?.base && src.kind !== "changes"
              ? await changedLinesBetween(review.repoRoot, src.base, src.head, rel)
              : await changedLines(review.repoRoot, rel, total),
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
    jobs?.on("change", onChange);
    proposals?.on("change", onChange);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      store.off("change", onChange);
      jobs?.off("change", onChange);
      proposals?.off("change", onChange);
    });
  });

  // ---- reviewing from Ferret: environment, repos, jobs, drafts ----

  const jsonOnly = (req: Request, res: Response): boolean => {
    if (req.is("application/json")) return true;
    res.status(415).json({ error: "Expected application/json" });
    return false;
  };

  r.get(
    "/env",
    wrap(async (_req, res) => {
      const [gh, claudeStatus, gitOk] = await Promise.all([
        github ? github.status() : Promise.resolve({ installed: false, loggedIn: false }),
        claudeInstalled ? claudeInstalled() : Promise.resolve({ installed: true }),
        isGitRepo(process.cwd()).then(() => true, () => true), // git itself: rev-parse failing still means git ran
      ]);
      const env: EnvStatus = { gh, claude: claudeStatus, git: { installed: gitOk } };
      res.json(env);
    }),
  );

  /** Distinct local clones seen so far (reviews' repos and job scopes), newest first. */
  const recentRepos = (): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (p?: string) => {
      if (!p) return;
      const key = p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    };
    for (const j of jobs?.list() ?? []) add(j.scope?.repo);
    for (const rv of store.list()) {
      add(rv.source?.repo);
      if (!rv.source?.worktree) add(rv.repoRoot);
    }
    return out;
  };

  r.get("/repos", (_req, res) => res.json({ repos: recentRepos() }));

  const repoParam = async (req: Request, res: Response): Promise<string | null> => {
    const repo = typeof req.query.repo === "string" ? req.query.repo : "";
    if (!repo) {
      res.status(400).json({ error: "Missing ?repo=" });
      return null;
    }
    if (!(await isGitRepo(repo))) {
      res.status(400).json({ error: `not a git repo: ${repo}` });
      return null;
    }
    return repo;
  };

  r.get(
    "/repos/info",
    wrap(async (req, res) => {
      const repo = await repoParam(req, res);
      if (!repo) return;
      const [origin, head, branches] = await Promise.all([originUrl(repo), headSha(repo), listBranches(repo)]);
      const def = await defaultBranch(repo).catch(() => branches[0] ?? "main");
      res.json({ isRepo: true, repoName: repoNameOf(repo), originOwnerRepo: origin ? ownerRepoFromOrigin(origin) : null, defaultBranch: def, head, branches });
    }),
  );

  r.get(
    "/repos/prs",
    wrap(async (req, res) => {
      const repo = await repoParam(req, res);
      if (!repo) return;
      if (!github) return res.status(503).json({ error: GH_UNAVAILABLE });
      try {
        res.json(await github.listPrs(repo));
      } catch (err) {
        if (err instanceof GithubError) return res.status(503).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.get(
    "/repos/commits",
    wrap(async (req, res) => {
      const repo = await repoParam(req, res);
      if (!repo) return;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      res.json(await listCommits(repo, limit));
    }),
  );

  if (jobs) {
    const jobsRef = jobs;
    r.get("/jobs", (_req, res) => res.json(jobsRef.list()));
    r.get("/jobs/:id", (req, res) => {
      const job = jobsRef.get(req.params.id);
      if (!job) return void res.status(404).json({ error: "Job not found" });
      res.json(job);
    });

    r.post(
      "/jobs",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        const parsed = startJobSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
        const scope = parsed.data.scope;
        let input: ScopeInput;
        if (scope.type === "pr" && scope.url) {
          const pr = parsePrUrl(scope.url);
          if (!pr) return res.status(400).json({ error: "Not a GitHub/Bitbucket pull request URL" });
          if (pr.host === "bitbucket") return res.status(400).json({ error: "Bitbucket PRs: review by branch (paste the PR's source branch)", bitbucket: true });
          let repo = scope.repo;
          if (repo) {
            // The PR's number only means something in the clone of that repo.
            const o = await originUrl(repo).catch(() => null);
            if (!o || !originMatches(o, pr.ownerRepo)) {
              return res.status(400).json({ error: `${repo} is not a clone of ${pr.ownerRepo} (its origin is ${o ?? "missing"}); pick the right local clone` });
            }
          } else {
            const candidates: string[] = [];
            for (const p of recentRepos()) {
              const o = await originUrl(p).catch(() => null);
              if (o && originMatches(o, pr.ownerRepo)) candidates.push(p);
            }
            if (candidates.length === 1) repo = candidates[0];
            else return res.status(409).json({ needsRepo: { ownerRepo: pr.ownerRepo, candidates } });
          }
          input = { type: "pr", repo, number: pr.number, host: "github" };
        } else if (scope.type === "pr") {
          if (!scope.repo || !scope.number) return res.status(400).json({ error: "pr needs a url, or a repo and a number" });
          input = { type: "pr", repo: scope.repo, number: scope.number, host: "github" };
        } else {
          input = scope;
        }
        if (!(await isGitRepo(input.repo))) return res.status(400).json({ error: `not a git repo: ${input.repo}` });
        if (parsed.data.task && !parseTaskRef(parsed.data.task)) return res.status(400).json({ error: "Paste a ClickUp task link (https://app.clickup.com/t/…) or a task id" });
        res.status(201).json(jobsRef.startReview(input, parsed.data.model, { whiteboard: parsed.data.whiteboard, task: parsed.data.task || undefined, notes: parsed.data.notes }));
      }),
    );

    r.post(
      "/jobs/:id/cancel",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        try {
          await jobsRef.cancel(req.params.id);
          res.json(jobsRef.get(req.params.id));
        } catch (err) {
          if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
          throw err;
        }
      }),
    );

    r.post(
      "/reviews/:id/findings/:fid/draft",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        try {
          res.status(201).json(jobsRef.startDraft(req.params.id, req.params.fid));
        } catch (err) {
          if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
          throw err;
        }
      }),
    );

    r.post(
      "/reviews/:id/draft-all",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        try {
          res.status(201).json(jobsRef.startDraftAll(req.params.id, Boolean((req.body as { redo?: boolean }).redo)));
        } catch (err) {
          if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
          throw err;
        }
      }),
    );
  }

  if (clickup) {
    const cu = clickup;
    r.get(
      "/clickup/status",
      wrap(async (_req, res) => res.json(await cu.status())),
    );
    r.post(
      "/clickup/token",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        const token = (req.body as { token?: unknown }).token;
        if (typeof token !== "string" || !token.trim()) return res.status(400).json({ error: "token required" });
        try {
          res.json({ ok: true, user: await cu.setToken(token) });
        } catch (err) {
          if (err instanceof ClickUpError) return res.status(err.status === 401 ? 401 : 400).json({ error: err.message });
          throw err;
        }
      }),
    );
    r.get(
      "/clickup/members",
      wrap(async (_req, res) => {
        try {
          res.json({ workspaces: await cu.members() });
        } catch (err) {
          if (err instanceof ClickUpError) return res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
          throw err;
        }
      }),
    );
    r.post(
      "/reviews/:id/clickup-dm",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        const review = store.get(req.params.id);
        if (!review) return res.status(404).json({ error: "Review not found" });
        const { workspaceId, userId, message, username, task } = req.body as {
          workspaceId?: unknown;
          userId?: unknown;
          message?: unknown;
          username?: unknown;
          task?: unknown;
        };
        if (typeof workspaceId !== "string" || !/^\d+$/.test(workspaceId)) return res.status(400).json({ error: "workspaceId required" });
        if (typeof userId !== "number" || !Number.isInteger(userId)) return res.status(400).json({ error: "userId required" });
        if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "message required" });
        if (typeof task !== "string" || !task.trim()) return res.status(400).json({ error: "task required" });
        const ref = parseTaskRef(task);
        if (!ref) return res.status(400).json({ error: "Paste a ClickUp task link (https://app.clickup.com/t/…) or a task id" });
        const counts = countBySeverity(review.findings.filter((f) => f.status !== "dismissed"));
        const comment = [
          `Ferret review · ${toSummary(review).label}`,
          `🔴 ${counts.critical} critical · 🟠 ${counts.high} high · 🟡 ${counts.medium} medium · 🟢 ${counts.low} low`,
          `Full review attached (ferret-review-${review.id}.md). Open it in Ferret (Export ▾ → Import review…) to read it on the code at the reviewed commit.`,
        ].join("\n");
        try {
          // 1. The real file: attached to the task (the only file upload ClickUp's API allows) + summary comment.
          const sent = await cu.send(ref, { filename: `ferret-review-${review.id}.md`, markdown: exportReview(review), comment });
          // 2. The person: a DM pointing at it.
          await cu.dm(
            workspaceId,
            userId,
            `${message.trim()}\n\nReview file (ferret-review-${review.id}.md) is attached here: ${sent.url}`,
            typeof username === "string" ? username : undefined,
          );
          res.json({ username: typeof username === "string" ? username : `user ${userId}`, taskName: sent.taskName, url: sent.url });
        } catch (err) {
          if (err instanceof ClickUpError) return res.status(err.status && err.status >= 400 && err.status < 500 ? err.status : 502).json({ error: err.message });
          throw err;
        }
      }),
    );
    r.post(
      "/reviews/:id/clickup",
      wrap(async (req, res) => {
        if (!jsonOnly(req, res)) return;
        const review = store.get(req.params.id);
        if (!review) return res.status(404).json({ error: "Review not found" });
        const task = (req.body as { task?: unknown }).task;
        if (typeof task !== "string" || !task.trim()) return res.status(400).json({ error: "task required" });
        const ref = parseTaskRef(task);
        if (!ref) return res.status(400).json({ error: "Paste a ClickUp task link (https://app.clickup.com/t/…) or a task id" });
        const counts = countBySeverity(review.findings.filter((f) => f.status !== "dismissed"));
        const comment = [
          `Ferret review · ${toSummary(review).label}`,
          `🔴 ${counts.critical} critical · 🟠 ${counts.high} high · 🟡 ${counts.medium} medium · 🟢 ${counts.low} low`,
          `Full review attached (ferret-review-${review.id}.md). Open it in Ferret (Export ▾ → Import review…) to read it on the code at the reviewed commit.`,
        ].join("\n");
        try {
          res.json(await cu.send(ref, { filename: `ferret-review-${review.id}.md`, markdown: exportReview(review), comment }));
        } catch (err) {
          if (err instanceof ClickUpError) return res.status(err.status && err.status >= 400 && err.status < 500 ? err.status : 502).json({ error: err.message });
          throw err;
        }
      }),
    );
  }

  r.get("/reviews/:id/export", (req, res) => {
    const review = store.get(req.params.id);
    if (!review) return void res.status(404).json({ error: "Review not found" });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ferret-review-${review.id}.md"`);
    res.send(exportReview(review));
  });

  r.post(
    "/reviews/import",
    wrap(async (req, res) => {
      if (!jsonOnly(req, res)) return;
      const { text, repo } = req.body as { text?: unknown; repo?: unknown };
      if (typeof text !== "string") return res.status(400).json({ error: "text required" });
      const parsed = parseExport(text);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const portable = parsed.review;
      let clone = typeof repo === "string" && repo ? repo : undefined;
      if (!clone) {
        const name = portable.source?.repoName;
        const candidates = recentRepos().filter((p) => !name || repoNameOf(p).toLowerCase() === name.toLowerCase());
        if (candidates.length === 1) clone = candidates[0];
        else return res.status(409).json({ needsRepo: { repoName: name ?? "", candidates } });
      }
      if (!jobs) return res.status(503).json({ error: "Import needs the job manager (worktrees)" });
      try {
        const review = await importReview(portable, clone, { store, worktreesDir: jobs.worktreesDir, by: parsed.by });
        res.status(201).json(review);
      } catch (err) {
        if (err instanceof ScopeError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.post(
    "/pick-folder",
    wrap(async (req, res) => {
      if (!jsonOnly(req, res)) return;
      if (!pickFolder) return res.status(404).json({ error: "No folder dialog in this build; type the path instead" });
      const p = await pickFolder();
      res.json(p ? { path: p } : { cancelled: true });
    }),
  );

  r.post(
    "/save-file",
    wrap(async (req, res) => {
      if (!jsonOnly(req, res)) return;
      if (!saveFile) return res.status(404).json({ error: "No save dialog in this build" });
      const { name, content } = req.body as { name?: unknown; content?: unknown };
      if (typeof name !== "string" || typeof content !== "string") return res.status(400).json({ error: "name and content required" });
      const p = await saveFile(name, content);
      res.json(p ? { path: p } : { cancelled: true });
    }),
  );

  if (proposals) mountProposalRoutes(r, proposals, deliver);

  return r;
}

/** The canned question "Refresh" sends when a step's `before` no longer matches the file. */
export const REFRESH_TEXT = "The file changed since you proposed this step. Please re-read it and revise the step.";
const DELIVERY_PREFIX = "Ferret: a decision on your proposal. Please handle it now: ";

type Delivery = { delivered: boolean; agent?: string; reason?: string };

// ---- proposal mode: decisions go straight into the proposing session ----
function mountProposalRoutes(r: Router, proposals: ProposalStore, deliver?: ApiOptions["deliver"]): void {
  const jsonOnly = (req: Request, res: Response): boolean => {
    if (req.is("application/json")) return true;
    res.status(415).json({ error: "Expected application/json" });
    return false;
  };
  const summary = (p: Proposal) => ({ id: p.id, title: p.task.title, status: p.status, createdAt: p.createdAt, progress: proposalProgress(p) });
  const views = (p: Proposal) => proposals.views(p, repoFileReader(p.repoRoot));
  const withStore = (fn: Handler) =>
    wrap(async (req, res) => {
      try {
        return await fn(req, res);
      } catch (err) {
        if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof Error && !(err instanceof TypeError)) return res.status(400).json({ error: err.message }); // store rules: blocked, applied, …
        throw err;
      }
    });

  const send = async (p: Proposal, command: string): Promise<Delivery> => {
    if (!deliver) return { delivered: false, reason: "This Ferret build cannot message Claude sessions" };
    if (!p.sessionId) return { delivered: false, reason: "The proposal did not record its Claude session" };
    const agent = (await listLiveSessions()).find((s) => s.sessionId === p.sessionId)?.name;
    if (!agent) return { delivered: false, reason: "The proposing Claude session isn't running" };
    try {
      await deliver(agent, `${DELIVERY_PREFIX}${command}`);
      return { delivered: true, agent };
    } catch (err) {
      return { delivered: false, agent, reason: (err as Error).message };
    }
  };

  r.get("/proposals", (_req, res) => res.json(proposals.list().map(summary)));

  r.get(
    "/proposals/:id",
    withStore(async (req, res) => {
      const p = proposals.get(req.params.id);
      if (!p) return res.status(404).json({ error: "Proposal not found" });
      res.json({ ...p, steps: await views(p) });
    }),
  );

  const decide = async (req: Request, res: Response, decision: { kind: "accept" | "decline" | "ask"; text?: string }) => {
    const { id, sid } = req.params;
    await proposals.decide(id, sid, decision);
    const p = proposals.get(id)!;
    const delivery = await send(p, decisionCommand(id, sid, decision));
    const step = (await views(p)).find((s) => s.stepId === sid)!;
    res.json({ step, ...delivery });
  };

  r.post(
    "/proposals/:id/steps/:sid/decide",
    withStore(async (req, res) => {
      if (!jsonOnly(req, res)) return;
      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      await decide(req, res, parsed.data);
    }),
  );

  r.post(
    "/proposals/:id/steps/:sid/refresh",
    withStore(async (req, res) => {
      if (!jsonOnly(req, res)) return;
      await decide(req, res, { kind: "ask", text: REFRESH_TEXT });
    }),
  );

  r.post(
    "/proposals/:id/accept-all",
    withStore(async (req, res) => {
      if (!jsonOnly(req, res)) return;
      const { id } = req.params;
      const accepted = await proposals.acceptAllRemaining(id);
      const p = proposals.get(id)!;
      if (accepted.length === 0) return res.json({ steps: [], delivered: false, reason: "Nothing left to accept" });
      const delivery = await send(p, acceptAllCommand(id));
      const ids = new Set(accepted.map((s) => s.stepId));
      res.json({ steps: (await views(p)).filter((s) => ids.has(s.stepId)), ...delivery });
    }),
  );

  /** The current text of a file in the proposal's repo, so the step card can show the change inside the whole file. */
  r.get(
    "/proposals/:id/file",
    withStore(async (req, res) => {
      const p = proposals.get(req.params.id);
      if (!p) return res.status(404).json({ error: "Proposal not found" });
      const rel = typeof req.query.path === "string" ? req.query.path : "";
      if (!rel) return res.status(400).json({ error: "path required" });
      try {
        const f = await readRepoFile(p.repoRoot, rel);
        res.json(f.exists ? { exists: true, content: f.content } : { exists: false });
      } catch (err) {
        if (err instanceof PathError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.post(
    "/proposals/:id/accept-steps",
    withStore(async (req, res) => {
      if (!jsonOnly(req, res)) return;
      const { stepIds: ids, texts: rawTexts } = req.body as { stepIds?: unknown; texts?: unknown };
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((x) => typeof x === "string")) {
        return res.status(400).json({ error: "stepIds must be a non-empty list of step ids" });
      }
      const texts: Record<string, string> = {};
      if (rawTexts !== undefined) {
        if (typeof rawTexts !== "object" || rawTexts === null || Array.isArray(rawTexts)) return res.status(400).json({ error: "texts must be an object" });
        for (const [k, v] of Object.entries(rawTexts)) {
          if (typeof v !== "string" || v.length > MAX_QUESTION) return res.status(400).json({ error: `texts.${k} must be a string of at most ${MAX_QUESTION} characters` });
          if (v.trim()) texts[k] = v;
        }
      }
      const { id } = req.params;
      const p0 = proposals.get(id);
      if (!p0) return res.status(404).json({ error: "Proposal not found" });
      const stale = new Set((await views(p0)).filter((s) => s.stale).map((s) => s.stepId));
      const { accepted, skipped } = await proposals.acceptSteps(id, ids as string[], stale, texts);
      const p = proposals.get(id)!;
      if (accepted.length === 0) return res.json({ steps: [], skipped, delivered: false, reason: "Nothing could be accepted" });
      const delivery = await send(p, acceptStepsCommand(id, accepted.map((s) => s.stepId)));
      const done = new Set(accepted.map((s) => s.stepId));
      res.json({ steps: (await views(p)).filter((s) => done.has(s.stepId)), skipped, ...delivery });
    }),
  );

  r.delete(
    "/proposals/:id",
    withStore(async (req, res) => {
      await proposals.delete(req.params.id);
      res.json({ ok: true });
    }),
  );
}

const repoField = z.string().min(1);
const startJobSchema = z.object({
  kind: z.literal("review"),
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("changes"), repo: repoField }),
    z.object({ type: z.literal("commit"), repo: repoField, sha: z.string().min(1) }),
    z.object({ type: z.literal("range"), repo: repoField, from: z.string().min(1), to: z.string().min(1) }),
    z.object({ type: z.literal("branch"), repo: repoField, branch: z.string().min(1), base: z.string().optional() }),
    z.object({ type: z.literal("pr"), repo: repoField.optional(), number: z.number().int().positive().optional(), url: z.string().min(1).optional(), host: z.literal("github").optional() }),
  ]),
  model: z.string().regex(MODEL_ID, "invalid model id").optional(),
  whiteboard: z.enum(["draw", "explain"]).optional(),
  task: z.string().trim().max(300).optional(),
  notes: z.string().max(8000).optional(),
});
