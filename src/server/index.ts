import express, { type RequestHandler } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApiRouter } from "./api";
import type { ClaudeIntegration } from "./claude";
import { mountMcp } from "./mcp";
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

export function createApp(opts: {
  store: ReviewStore;
  getPort: () => number;
  uiDir?: string;
  claude?: ClaudeIntegration;
}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(hostGuard(opts.getPort));
  app.use("/api", createApiRouter(opts.store, opts.claude));
  mountMcp(app, opts.store, () => `http://${HOST}:${opts.getPort()}`);
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
  close(): Promise<void>;
}

export async function startServer(
  opts: { port?: number; home?: string; uiDir?: string; log?: (m: string) => void; claude?: ClaudeIntegration } = {},
): Promise<RunningServer> {
  const store = new ReviewStore(path.join(opts.home ?? defaultHome(), "reviews"), opts.log);
  await store.load();
  let port = opts.port ?? 4477;
  const app = createApp({ store, getPort: () => port, uiDir: opts.uiDir, claude: opts.claude });
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, HOST, () => resolve(s));
    s.on("error", reject);
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${HOST}:${port}`,
    port,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
