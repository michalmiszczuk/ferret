// "Open in Whiteboard": Ferret draws a review's findings on a Whiteboard (dev.fast) canvas — a section per severity,
// each finding a callout with a code peek on its lines, multi-place paths as flow diagrams. Ferret talks to Whiteboard
// over its MCP server, launched with the same command Claude Code is registered with (~/.claude.json).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import { countBySeverity, SEVERITY_LABEL, sortFindings, toSummary } from "../shared/findings";
import { SEVERITIES, type Finding, type Review, type ReviewSource, type Severity } from "../shared/schema";

export class WhiteboardError extends Error {}

export interface WhiteboardConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface WhiteboardStatus {
  registered: boolean;
  running: boolean;
  url?: string;
  error?: string;
}

/** What a Whiteboard document is pinned to: the review's source, or the checkout for chat reviews. */
export interface WhiteboardTarget {
  source?: ReviewSource;
  repoRoot: string;
  scopeKind: "files" | "diff";
}

export interface WhiteboardService {
  status(): Promise<WhiteboardStatus>;
  /** Creates (or reuses) the review's Whiteboard and draws the findings. Returns the Whiteboard session id. */
  publish(review: Review, existingSessionId?: string): Promise<{ sessionId: string }>;
  open(sessionId: string): Promise<void>;
  /** An active Whiteboard already pinned to this PR / head commit, if any (e.g. one a chat session drew). */
  findExisting(target: WhiteboardTarget): Promise<string | undefined>;
  /** An empty Whiteboard pinned to the target, for headless Claude to write the explanation into. */
  createSession(target: WhiteboardTarget, title: string, open: boolean): Promise<string>;
  /** The document as text with its anchors (capped), to feed a review as the map of the change. */
  readOutline(sessionId: string, maxChars?: number): Promise<string>;
  /** The whiteboard MCP server, for giving a headless Claude run the Whiteboard tools. */
  mcpServer(): Promise<Record<string, unknown> | null>;
}

/** The whiteboard MCP server as registered for Claude Code (user scope), or null when Whiteboard isn't set up. */
export async function findWhiteboardConfig(claudeJson = path.join(os.homedir(), ".claude.json")): Promise<WhiteboardConfig | null> {
  try {
    const j = JSON.parse(await fs.readFile(claudeJson, "utf8")) as { mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; env?: Record<string, string> }> };
    const s = j.mcpServers?.whiteboard;
    if (!s?.command || (s.type && s.type !== "stdio")) return null;
    return { command: s.command, args: s.args ?? [], env: s.env };
  } catch {
    return null;
  }
}

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };
type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Starts Whiteboard Desktop in the background through the same CLI the MCP server runs from (`… cli.js app launch`). */
async function launchApp(cfg: WhiteboardConfig): Promise<void> {
  const args = [...cfg.args];
  if (args[args.length - 1] === "mcp") args.pop();
  await execFileP(cfg.command, [...args, "app", "launch", "--json"], {
    env: { ...process.env, ...(cfg.env ?? {}) },
    windowsHide: true,
    timeout: 30_000,
  });
}

/** Whiteboard's server only authors into a running Desktop: start it when needed and wait until it answers. */
async function ensureRunning(call: Call, cfg: WhiteboardConfig): Promise<void> {
  const status = async () => (await call("whiteboard_status", {})) as { desktopAvailable?: boolean };
  if ((await status()).desktopAvailable) return;
  await launchApp(cfg);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await status()).desktopAvailable) return;
  }
  throw new WhiteboardError("Whiteboard Desktop did not come up. Start it by hand (whiteboard app launch) and try again.");
}

/** One short-lived MCP connection per operation (the server is a small CLI process). */
async function withClient<T>(cfg: WhiteboardConfig, fn: (call: Call) => Promise<T>, opts: { ensureRunning?: boolean } = {}): Promise<T> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CLAUDECODE") env[k] = v;
  Object.assign(env, cfg.env ?? {});
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: "pipe" });
  const client = new Client({ name: "ferret", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    throw new WhiteboardError(`Could not start Whiteboard's MCP server: ${(err as Error).message}`);
  }
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const r = (await client.callTool({ name, arguments: args })) as ToolResult;
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new WhiteboardError(text.slice(0, 400) || `Whiteboard ${name} failed`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  try {
    if (opts.ensureRunning) await ensureRunning(call, cfg);
    return await fn(call);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Same as withClient, but starts Whiteboard Desktop first when it isn't running. */
const running = <T,>(cfg: WhiteboardConfig, fn: (call: Call) => Promise<T>): Promise<T> => withClient(cfg, fn, { ensureRunning: true });

const anchor = (f: { file: string; lineStart: number; lineEnd: number }) =>
  `head/${f.file.replace(/\\/g, "/")}#L${f.lineStart}${f.lineEnd !== f.lineStart ? `-L${f.lineEnd}` : ""}`;

const TONE: Record<Severity, "danger" | "warning" | "info" | "success"> = { critical: "danger", high: "warning", medium: "info", low: "info" };

/** The components that draw one finding inside its severity section. */
export function findingComponents(f: Finding): Record<string, unknown>[] {
  const body = [f.body.trim(), f.suggestion ? `**Suggestion**\n\n${f.suggestion.trim()}` : "", f.myNote ? `**My note:** ${f.myNote.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const children: Record<string, unknown>[] = [
    { type: "code_peek", source: anchor(f), caption: `${f.file}:${f.lineStart}` },
    { type: "markdown", markdown: body },
  ];
  if (f.steps?.length) {
    children.push({
      type: "flow_diagram",
      title: `Path · ${f.steps.length} places`,
      direction: "down",
      nodes: f.steps.map((s, i) => ({
        key: `s${i + 1}`,
        label: `${i + 1}. ${s.note}`,
        kind: i === f.steps!.length - 1 ? "terminal" : "process",
        attachments: [{ label: `${s.file}:${s.lineStart}`, sources: [anchor(s)] }],
      })),
      edges: f.steps.slice(1).map((_, i) => ({ from: `s${i + 1}`, to: `s${i + 2}` })),
    });
  }
  const status = f.status === "dismissed" ? " · dismissed" : f.status === "fixed" ? " · fixed" : "";
  return [{ type: "callout", tone: TONE[f.severity], title: `${f.title} (${f.category}${status})`, children }];
}

function createArgs(t: WhiteboardTarget, title: string, open = true): Record<string, unknown> {
  const s = t.source;
  const base = { title, open };
  if (s?.kind === "pr" && s.url) return { ...base, pullRequestUrl: s.url, repositoryPath: s.repo, reuseExisting: false };
  if (s && s.base) return { ...base, target: { kind: "commits", repositoryPath: s.repo, head: s.head, base: s.base } };
  if (s?.kind === "changes") return { ...base, target: { kind: "worktree", repositoryPath: s.repo, base: "HEAD" } };
  if (s) return { ...base, target: { kind: "commits", repositoryPath: s.repo, head: s.head } };
  // A chat review of the working copy / some files: the checkout as it is.
  return { ...base, target: { kind: "worktree", repositoryPath: t.repoRoot, ...(t.scopeKind === "diff" ? { base: "HEAD" } : {}) } };
}

const targetOf = (review: Review): WhiteboardTarget => ({ source: review.source, repoRoot: review.repoRoot, scopeKind: review.scope.kind });

function sessionIdOf(result: unknown): string | undefined {
  const r = result as { sessionId?: string; session?: { sessionId?: string; id?: string }; id?: string } | string;
  if (typeof r !== "object" || r === null) return undefined;
  return r.session?.sessionId ?? r.sessionId ?? r.session?.id ?? r.id;
}

export function createWhiteboard(opts: { config?: WhiteboardConfig | null; log?: (m: string) => void } = {}): WhiteboardService {
  const getConfig = async () => opts.config ?? (await findWhiteboardConfig());

  return {
    async status() {
      const cfg = await getConfig();
      if (!cfg) return { registered: false, running: false, error: "Whiteboard isn't connected to Claude Code (no whiteboard MCP server in ~/.claude.json)" };
      try {
        return await withClient(cfg, async (call) => {
          const st = (await call("whiteboard_status", {})) as { desktopAvailable?: boolean; url?: string; problem?: string };
          return { registered: true, running: Boolean(st.desktopAvailable), url: st.url, error: st.desktopAvailable ? undefined : st.problem };
        });
      } catch (err) {
        return { registered: true, running: false, error: (err as Error).message };
      }
    },

    async publish(review, existingSessionId) {
      const cfg = await getConfig();
      if (!cfg) throw new WhiteboardError("Whiteboard isn't connected to Claude Code");
      const label = toSummary(review).label;
      return running(cfg, async (call) => {
        let sessionId = existingSessionId;
        if (!sessionId) {
          const created = await call("session_create", createArgs(targetOf(review), `Ferret · ${label}`));
          sessionId = sessionIdOf(created);
          if (!sessionId) throw new WhiteboardError(`Whiteboard did not return a session id (${JSON.stringify(created).slice(0, 200)})`);
        } else {
          await call("session_open", { sessionId }).catch(() => {});
        }
        const act = (await call("session_activity_begin", { sessionId, focus: { description: "Drawing Ferret findings" } })) as { activityId?: string };
        const activityId = act.activityId;
        const edit = (content: Record<string, unknown>) => call("session_edit", { sessionId, ...(activityId ? { activityId } : {}), edit: { type: "insert", content } });

        const active = sortFindings(review.findings.filter((f) => f.status !== "dismissed"));
        const counts = countBySeverity(active);
        await edit({
          type: "section",
          title: `Ferret review · ${label}`,
          children: [
            { type: "markdown", markdown: review.summary.trim() },
            {
              type: "markdown",
              markdown: `**Findings:** ${active.length} — 🔴 ${counts.critical} critical · 🟠 ${counts.high} high · 🟡 ${counts.medium} medium · 🟢 ${counts.low} low. Reviewed with Ferret on ${review.createdAt.slice(0, 10)}; each callout links to the exact lines.`,
            },
          ],
        });
        for (const sev of SEVERITIES) {
          const group = active.filter((f) => f.severity === sev);
          if (group.length === 0) continue;
          await edit({
            type: "section",
            title: `${SEVERITY_LABEL[sev]} (${group.length})`,
            defaultCollapsed: sev === "low",
            children: group.flatMap(findingComponents),
          });
        }
        const dismissed = review.findings.filter((f) => f.status === "dismissed");
        if (dismissed.length) {
          await edit({
            type: "section",
            title: `Dismissed (${dismissed.length})`,
            defaultCollapsed: true,
            children: [{ type: "markdown", markdown: dismissed.map((f) => `- ${f.title} ([${f.file}:${f.lineStart}](review-source:${anchor(f)}))`).join("\n") }],
          });
        }
        if (activityId) await call("session_activity_end", { sessionId, activityId }).catch(() => {});
        opts.log?.(`Ferret: drew ${active.length} findings on Whiteboard ${sessionId}`);
        return { sessionId };
      });
    },

    async open(sessionId) {
      const cfg = await getConfig();
      if (!cfg) throw new WhiteboardError("Whiteboard isn't connected to Claude Code");
      await running(cfg, (call) => call("session_open", { sessionId }));
    },

    async findExisting(target) {
      const cfg = await getConfig();
      const s = target.source;
      if (!cfg || !s) return undefined;
      return running(cfg, async (call) => {
        const list = (await call("session_list", {})) as { sessionId: string; trashedAt?: string | null; origin?: { pullRequestUrl?: string }; target?: { head?: string } }[];
        if (!Array.isArray(list)) return undefined;
        const live = list.filter((r) => !r.trashedAt);
        const byPr = s.kind === "pr" && s.url ? live.find((r) => r.origin?.pullRequestUrl === s.url) : undefined;
        return (byPr ?? live.find((r) => r.target?.head === s.head))?.sessionId;
      });
    },

    async createSession(target, title, open) {
      const cfg = await getConfig();
      if (!cfg) throw new WhiteboardError("Whiteboard isn't connected to Claude Code");
      return running(cfg, async (call) => {
        const created = await call("session_create", createArgs(target, title, open));
        const id = sessionIdOf(created);
        if (!id) throw new WhiteboardError(`Whiteboard did not return a session id (${JSON.stringify(created).slice(0, 200)})`);
        return id;
      });
    },

    async readOutline(sessionId, maxChars = 60_000) {
      const cfg = await getConfig();
      if (!cfg) throw new WhiteboardError("Whiteboard isn't connected to Claude Code");
      return running(cfg, async (call) => {
        const r = await call("session_get", { sessionId, full: true });
        const text = typeof r === "string" ? r : JSON.stringify(r);
        return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[… outline truncated]` : text;
      });
    },

    async mcpServer() {
      const cfg = await getConfig();
      if (!cfg) return null;
      return { type: "stdio", command: cfg.command, args: cfg.args, env: cfg.env ?? {} };
    },
  };
}
