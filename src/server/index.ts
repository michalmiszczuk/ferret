import express, { type RequestHandler } from "express";
import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApiRouter } from "./api";
import type { ClaudeIntegration } from "./claude";
import { createClickUp, type ClickUpService } from "./clickup";
import { deliverToSession } from "./deliver";
import { createWhiteboard, type WhiteboardService } from "./whiteboard";
import { createGithub, type Github } from "./github";
import { JobManager } from "./jobs";
import { mountMcp } from "./mcp";
import { skillRules } from "./prompts";
import { ReviewStore } from "./store";

export const HOST = "127.0.0.1";

export function defaultHome(): string {
  return process.env.REVIEW_APP_HOME ?? path.join(os.homedir(), ".review-app");
}

/** Blocks DNS-rebinding: only requests addressed to localhost on our port get through. */
export function hostGuard(getPort: () => number): RequestHandler {
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    const port = getPort();
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return next();
    res.status(403).send("Forbidden host");
  };
}

export interface ServerOptions {
  port?: number;
  home?: string;
  uiDir?: string;
  log?: (m: string) => void;
  claude?: ClaudeIntegration;
  openExternal?: (url: string) => Promise<void>;
  /** Folder holding ai-review/SKILL.md etc.; its rules drive headless reviews. */
  skillsDir?: string;
  /** Override the `claude` executable (dev: tests/fake-claude/claude.cjs). Default: env REVIEW_APP_CLAUDE or "claude". */
  claudePath?: string;
  github?: Github;
  clickup?: ClickUpService;
  whiteboard?: WhiteboardService;
  pickFolder?: () => Promise<string | null>;
  saveFile?: (suggestedName: string, content: string) => Promise<string | null>;
  claudeInstalled?: () => Promise<{ installed: boolean; version?: string }>;
}

export function createApp(opts: {
  store: ReviewStore;
  jobs: JobManager;
  github: Github;
  getPort: () => number;
  uiDir?: string;
  claude?: ClaudeIntegration;
  openExternal?: (url: string) => Promise<void>;
  pickFolder?: ServerOptions["pickFolder"];
  saveFile?: ServerOptions["saveFile"];
  claudeInstalled?: ServerOptions["claudeInstalled"];
  clickup?: ClickUpService;
  deliver?: (agent: string, text: string) => Promise<void>;
  whiteboard?: WhiteboardService;
}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(hostGuard(opts.getPort));
  app.use(
    "/api",
    createApiRouter(opts.store, {
      claude: opts.claude,
      openExternal: opts.openExternal,
      jobs: opts.jobs,
      github: opts.github,
      pickFolder: opts.pickFolder,
      saveFile: opts.saveFile,
      claudeInstalled: opts.claudeInstalled,
      clickup: opts.clickup,
      deliver: opts.deliver,
      whiteboard: opts.whiteboard,
    }),
  );
  mountMcp(app, opts.store, () => `http://${HOST}:${opts.getPort()}`, {
    jobs: opts.jobs,
    prInfo: (repo, n) => opts.github.prInfo(repo, n),
    worktreesDir: opts.jobs.worktreesDir,
  });
  if (opts.uiDir) {
    const uiDir = opts.uiDir;
    app.use(express.static(uiDir));
    app.get("*", (_req, res) => res.sendFile(path.join(uiDir, "index.html")));
  }
  app.use(((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }) as express.ErrorRequestHandler);
  return app;
}

export interface RunningServer {
  url: string;
  port: number;
  store: ReviewStore;
  jobs: JobManager;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const home = opts.home ?? defaultHome();
  const log = opts.log ?? console.warn;
  const store = new ReviewStore(path.join(home, "reviews"), log);
  await store.load();
  let port = opts.port ?? 4477;
  const mcpUrl = () => `http://${HOST}:${port}/mcp`;

  let rules = "";
  if (opts.skillsDir) {
    try {
      rules = skillRules(await fs.readFile(path.join(opts.skillsDir, "ai-review", "SKILL.md"), "utf8"));
    } catch (err) {
      log(`Ferret: could not read the ai-review skill (${(err as Error).message}); headless reviews will run without its rules`);
    }
  }
  const github = opts.github ?? createGithub();
  const whiteboard = opts.whiteboard ?? createWhiteboard({ log });
  const jobs = new JobManager({
    store,
    home,
    mcpUrl: mcpUrl(), // port 0 (tests) is fixed up after listen below
    rules,
    prInfo: (repo, n) => github.prInfo(repo, n),
    claudePath: opts.claudePath ?? process.env.REVIEW_APP_CLAUDE,
    log,
    whiteboard,
  });
  await jobs.load();
  await jobs.sweepWorktrees(); // jobs from a previous run were just marked cancelled, so only reviews hold worktrees now

  const app = createApp({
    store,
    jobs,
    github,
    getPort: () => port,
    uiDir: opts.uiDir,
    claude: opts.claude,
    openExternal: opts.openExternal,
    pickFolder: opts.pickFolder,
    saveFile: opts.saveFile,
    claudeInstalled: opts.claudeInstalled,
    clickup: opts.clickup ?? createClickUp(path.join(home, "clickup.json")),
    deliver: (agent, text) =>
      deliverToSession(agent, text, { sandboxDir: jobs.sandboxDir, claudePath: opts.claudePath ?? process.env.REVIEW_APP_CLAUDE }),
    whiteboard,
  });
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, HOST, () => resolve(s));
    s.on("error", reject);
  });
  port = (server.address() as AddressInfo).port;
  jobs.setMcpUrl(mcpUrl());
  return {
    url: `http://${HOST}:${port}`,
    port,
    store,
    jobs,
    close: async () => {
      await jobs.shutdown(); // no claude/git process outlives the app
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
