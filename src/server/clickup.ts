// Send a review to a teammate (DM with a ClickUp Doc holding the review) or to a task (.md attached + comment).
// Auth is the user's personal API token (ClickUp → Settings → Apps → API Token, starts with "pk_"),
// kept in ~/.review-app/clickup.json and never sent to the UI.
import { promises as fs } from "node:fs";
import path from "node:path";

export class ClickUpError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface TaskRef {
  taskId: string;
  teamId?: string;
  custom: boolean;
}

export interface Person {
  id: number;
  username: string;
  email?: string;
  initials?: string;
  profilePicture?: string;
}

export interface Workspace {
  id: string;
  name: string;
  members: Person[];
}

export interface RecentTask {
  id: string;
  name: string;
  url: string;
  usedAt: string;
}

export interface RecentPerson {
  id: number;
  username: string;
  workspaceId: string;
  usedAt: string;
}

export interface ClickUpStatus {
  configured: boolean;
  user?: string;
  recent: RecentTask[];
  recentPeople: RecentPerson[];
}

export interface SendResult {
  taskId: string;
  taskName: string;
  url: string;
}


/** What a reviewer needs to know about the task a change implements. */
export interface TaskContext {
  id: string;
  name: string;
  url: string;
  status?: string;
  description: string;
  comments: { by: string; at: string; text: string }[];
  attachments: { title: string; url: string }[];
}

/** The task as a prompt section (capped so a chatty task can't crowd out the code). */
export function formatTaskContext(t: TaskContext, maxChars = 8000): string {
  const lines = [`**${t.name}**${t.status ? ` (${t.status})` : ""} — ${t.url}`, ""];
  lines.push(t.description.trim() || "_(no description)_", "");
  if (t.attachments.length) {
    lines.push("Attachments (not read; names only):", ...t.attachments.map((a) => `- ${a.title} — ${a.url}`), "");
  }
  if (t.comments.length) {
    lines.push("Recent comments (newest last):");
    for (const c of t.comments) lines.push(`- ${c.by} (${c.at.slice(0, 10)}): ${c.text.replace(/\s+/g, " ").trim()}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[… task text truncated]` : text;
}

export interface ClickUpService {
  status(): Promise<ClickUpStatus>;
  /** Reads a task's description, latest comments and attachment names (for review context). */
  taskContext(ref: TaskRef): Promise<TaskContext>;
  /** Verifies the token against /user and saves it. Returns the username. */
  setToken(token: string): Promise<string>;
  /** The user's workspaces with their members (for the people picker). */
  members(): Promise<Workspace[]>;
  /** Attaches the markdown file to a task and posts the comment. */
  send(ref: TaskRef, content: { filename: string; markdown: string; comment: string }): Promise<SendResult>;
  /** Sends the person a chat message (Markdown, as the user). */
  dm(workspaceId: string, userId: number, message: string, username?: string): Promise<void>;
}

const apiBase = () => process.env.REVIEW_APP_CLICKUP_API ?? "https://api.clickup.com/api";
const appBase = () => process.env.REVIEW_APP_CLICKUP_APP ?? "https://app.clickup.com";

/** A task link (https://app.clickup.com/t/abc123 or /t/<team>/PROJ-12) or a bare task id. */
export function parseTaskRef(input: string): TaskRef | null {
  const s = input.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  let m = /^https?:\/\/app\.clickup\.com\/t\/(\d+)\/([A-Za-z0-9][\w-]*)$/i.exec(s);
  if (m) return { taskId: m[2], teamId: m[1], custom: true };
  m = /^https?:\/\/app\.clickup\.com\/t\/([A-Za-z0-9][\w-]*)$/i.exec(s);
  if (m) return { taskId: m[1], custom: false };
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(s)) return { taskId: s, custom: true }; // custom id needs the URL (no team id here)
  if (/^[A-Za-z0-9][\w-]{3,}$/.test(s)) return { taskId: s, custom: false };
  return null;
}

interface Stored {
  token?: string;
  user?: string;
  recent?: RecentTask[];
  recentPeople?: RecentPerson[];
}

export function createClickUp(file: string): ClickUpService {
  async function load(): Promise<Stored> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as Stored;
    } catch {
      return {};
    }
  }

  async function save(data: Stored): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  }

  async function call<T>(token: string, pathname: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${apiBase()}${pathname}`, {
        ...init,
        headers: { Authorization: token, ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ClickUpError(`Could not reach ClickUp: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: { err?: string } = {};
    try {
      body = JSON.parse(text) as { err?: string };
    } catch {
      // non-JSON error page
    }
    if (res.status === 401) throw new ClickUpError("ClickUp rejected the token. Paste a fresh one (ClickUp → Settings → Apps → API Token).", 401);
    if (!res.ok) throw new ClickUpError(body.err ?? `ClickUp replied ${res.status}`, res.status);
    return body as T;
  }

  async function requireToken(): Promise<{ token: string; data: Stored }> {
    const data = await load();
    if (!data.token) throw new ClickUpError("No ClickUp token saved yet", 401);
    return { token: data.token, data };
  }

  async function listWorkspaces(token: string): Promise<Workspace[]> {
    const body = await call<{ teams?: { id: string; name: string; members?: { user?: Partial<Person> }[] }[] }>(token, "/v2/team");
    return (body.teams ?? []).map((t) => ({
      id: String(t.id),
      name: t.name,
      members: (t.members ?? [])
        .flatMap((m) => (m.user && typeof m.user.id === "number" && m.user.username ? [m.user as Person] : []))
        .map(({ id, username, email, initials, profilePicture }) => ({ id, username, email, initials, profilePicture }))
        .sort((a, b) => a.username.localeCompare(b.username)),
    }));
  }

  return {
    async status() {
      const data = await load();
      return { configured: Boolean(data.token), user: data.user, recent: data.recent ?? [], recentPeople: data.recentPeople ?? [] };
    },

    async setToken(token) {
      const t = token.trim();
      if (!t) throw new ClickUpError("Token is empty");
      const body = await call<{ user?: { username?: string } }>(t, "/v2/user");
      const user = body.user?.username ?? "unknown";
      const data = await load();
      await save({ ...data, token: t, user });
      return user;
    },

    async members() {
      const { token } = await requireToken();
      return listWorkspaces(token);
    },

    async taskContext(ref) {
      const { token } = await requireToken();
      if (ref.custom && !ref.teamId) {
        throw new ClickUpError("That looks like a custom task id: paste the full task link (https://app.clickup.com/t/<team>/<ID-123>) instead.");
      }
      const q = ref.custom ? `&custom_task_ids=true&team_id=${encodeURIComponent(ref.teamId!)}` : "";
      const task = await call<{
        id: string;
        name?: string;
        url?: string;
        status?: { status?: string };
        description?: string;
        markdown_description?: string;
        attachments?: { title?: string; url?: string }[];
      }>(token, `/v2/task/${encodeURIComponent(ref.taskId)}?include_markdown_description=true${q}`);
      if (!task.id) throw new ClickUpError("ClickUp did not return the task (check the link)");
      let comments: TaskContext["comments"] = [];
      try {
        const c = await call<{ comments?: { comment_text?: string; user?: { username?: string }; date?: string }[] }>(token, `/v2/task/${encodeURIComponent(task.id)}/comment`);
        comments = (c.comments ?? [])
          .map((x) => ({ by: x.user?.username ?? "someone", at: x.date ? new Date(Number(x.date)).toISOString() : "", text: x.comment_text ?? "" }))
          .filter((x) => x.text.trim())
          .slice(0, 10)
          .reverse();
      } catch {
        // comments are optional context
      }
      return {
        id: task.id,
        name: task.name ?? ref.taskId,
        url: task.url ?? `${appBase()}/t/${task.id}`,
        status: task.status?.status,
        description: task.markdown_description ?? task.description ?? "",
        comments,
        attachments: (task.attachments ?? []).flatMap((a) => (a.url ? [{ title: a.title ?? "attachment", url: a.url }] : [])),
      };
    },

    async send(ref, content) {
      const { token, data } = await requireToken();
      if (ref.custom && !ref.teamId) {
        throw new ClickUpError("That looks like a custom task id: paste the full task link (https://app.clickup.com/t/<team>/<ID-123>) instead.");
      }
      const q = ref.custom ? `?custom_task_ids=true&team_id=${encodeURIComponent(ref.teamId!)}` : "";
      const task = await call<{ id: string; name?: string; url?: string }>(token, `/v2/task/${encodeURIComponent(ref.taskId)}${q}`);
      if (!task.id) throw new ClickUpError("ClickUp did not return the task (check the link)");

      const form = new FormData();
      form.append("attachment", new Blob([content.markdown], { type: "text/markdown" }), content.filename);
      await call(token, `/v2/task/${encodeURIComponent(task.id)}/attachment`, { method: "POST", body: form });
      await call(token, `/v2/task/${encodeURIComponent(task.id)}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment_text: content.comment }),
      });

      const url = task.url ?? `${appBase()}/t/${task.id}`;
      const name = task.name ?? ref.taskId;
      const recent: RecentTask[] = [
        { id: task.id, name, url, usedAt: new Date().toISOString() },
        ...(data.recent ?? []).filter((r) => r.id !== task.id),
      ].slice(0, 5);
      await save({ ...data, recent });
      return { taskId: task.id, taskName: name, url };
    },

    async dm(workspaceId, userId, message, username) {
      const { token, data } = await requireToken();
      const ws = encodeURIComponent(workspaceId);
      // The person's existing DM channel comes back when there is one.
      const dm = await call<{ data?: { id?: string } }>(token, `/v3/workspaces/${ws}/chat/channels/direct_message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_ids: [String(userId)] }),
      });
      const channelId = dm.data?.id;
      if (!channelId) throw new ClickUpError("ClickUp did not return the direct-message channel");
      await call(token, `/v3/workspaces/${ws}/chat/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "message", content: message.slice(0, 39_000), content_format: "text/md" }),
      });
      const recentPeople: RecentPerson[] = [
        { id: userId, username: username ?? `user ${userId}`, workspaceId, usedAt: new Date().toISOString() },
        ...(data.recentPeople ?? []).filter((p) => p.id !== userId),
      ].slice(0, 5);
      await save({ ...data, recentPeople });
    },
  };
}
