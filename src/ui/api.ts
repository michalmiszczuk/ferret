import type {
  ClaudeConnectResult, ClaudeStatus, CommitSummary, EnvStatus, FileResponse, Job, PrSummary, ReviewSummary, StoreEvent,
} from "../shared/api-types";

export interface RepoInfo {
  isRepo: boolean;
  repoName: string;
  originOwnerRepo: string | null;
  defaultBranch: string;
  head: string;
  branches: string[];
}
import type { Finding, FindingPatch, Review } from "../shared/schema";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const fetchReviews = () => fetch("/api/reviews").then((r) => json<ReviewSummary[]>(r));
// ---- ClickUp ----
export interface ClickUpPerson {
  id: number;
  username: string;
  email?: string;
  initials?: string;
  profilePicture?: string;
}
export interface ClickUpWorkspace {
  id: string;
  name: string;
  members: ClickUpPerson[];
}
export interface ClickUpStatus {
  configured: boolean;
  user?: string;
  recent: { id: string; name: string; url: string; usedAt: string }[];
  recentPeople: { id: number; username: string; workspaceId: string; usedAt: string }[];
}
export const fetchClickUpStatus = () => fetch("/api/clickup/status").then((r) => json<ClickUpStatus>(r));
export const saveClickUpToken = (token: string) =>
  fetch("/api/clickup/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).then((r) =>
    json<{ ok: true; user: string }>(r),
  );
export const fetchClickUpMembers = () => fetch("/api/clickup/members").then((r) => json<{ workspaces: ClickUpWorkspace[] }>(r));
export const sendClickUpDm = (reviewId: string, body: { workspaceId: string; userId: number; username: string; message: string; task: string }) =>
  fetch(`/api/reviews/${enc(reviewId)}/clickup-dm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<{ username: string; taskName: string; url: string }>(r));
export const sendToClickUp = (reviewId: string, task: string) =>
  fetch(`/api/reviews/${enc(reviewId)}/clickup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  }).then((r) => json<{ taskId: string; taskName: string; url: string }>(r));

// ---- running Claude sessions (direct delivery) ----
export interface LiveAgent {
  name: string;
  sessionId: string;
  cwd: string;
  status: string;
}
export const fetchClaudeAgents = () => fetch("/api/claude/agents").then((r) => json<{ agents: LiveAgent[]; canDeliver: boolean }>(r));
export const deliverToAgent = (agent: string, text: string) =>
  fetch("/api/claude/deliver", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, text }),
  }).then((r) => json<{ ok: true }>(r));

/** The Claude Code chat most recently used in that folder (null when there is none). */
export const fetchLatestSession = (dir: string) =>
  fetch(`/api/claude/session?dir=${enc(dir)}`).then((r) => json<{ sessionId: string; modifiedAt: string } | null>(r));

export const fetchReview = (id: string) => fetch(`/api/reviews/${enc(id)}`).then((r) => json<Review>(r));

export const fetchFile = (id: string, path: string) =>
  fetch(`/api/reviews/${enc(id)}/file?path=${enc(path)}`).then((r) => json<FileResponse>(r));

export const patchFinding = (id: string, findingId: string, patch: FindingPatch) =>
  fetch(`/api/reviews/${enc(id)}/findings/${enc(findingId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => json<Finding>(r));

/** Asks the app to open vscode:// links in order (with a pause between). Rejects if the server can't. */
export const openInVsCode = (urls: string[]) =>
  fetch("/api/open-vscode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  }).then((r) => json<{ ok: boolean }>(r));

export const deleteReview =(id: string) =>
  fetch(`/api/reviews/${enc(id)}`, { method: "DELETE" }).then((r) => json<{ deleted: number }>(r));

export const clearReviews = () => fetch("/api/reviews", { method: "DELETE" }).then((r) => json<{ deleted: number }>(r));

export const fetchClaudeStatus =() => fetch("/api/claude/status").then((r) => json<ClaudeStatus>(r));

export const connectClaude = () =>
  fetch("/api/claude/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) =>
    json<ClaudeConnectResult>(r),
  );

// ---- reviewing from Ferret ----

const postJson = <T,>(p: string, body: unknown) =>
  fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => json<T>(r));

export const fetchEnv = () => fetch("/api/env").then((r) => json<EnvStatus>(r));
export const fetchRepos = () => fetch("/api/repos").then((r) => json<{ repos: string[] }>(r));
export const fetchRepoInfo = (repo: string) => fetch(`/api/repos/info?repo=${enc(repo)}`).then((r) => json<RepoInfo>(r));
export const fetchPrs = (repo: string) => fetch(`/api/repos/prs?repo=${enc(repo)}`).then((r) => json<PrSummary[]>(r));
export const fetchCommits = (repo: string, limit = 100) =>
  fetch(`/api/repos/commits?repo=${enc(repo)}&limit=${limit}`).then((r) => json<CommitSummary[]>(r));
export const fetchJobs = () => fetch("/api/jobs").then((r) => json<Job[]>(r));
export const cancelJob = (id: string) => postJson<Job>(`/api/jobs/${enc(id)}/cancel`, {});
export const startDraft = (reviewId: string, findingId: string) => postJson<Job>(`/api/reviews/${enc(reviewId)}/findings/${enc(findingId)}/draft`, {});
export const startDraftAll = (reviewId: string, redo = false) => postJson<Job>(`/api/reviews/${enc(reviewId)}/draft-all`, { redo });
export const fetchExport = (reviewId: string) => fetch(`/api/reviews/${enc(reviewId)}/export`).then(async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.text();
});

export type StartJobScope =
  | { type: "changes"; repo: string }
  | { type: "commit"; repo: string; sha: string }
  | { type: "range"; repo: string; from: string; to: string }
  | { type: "branch"; repo: string; branch: string; base?: string }
  | { type: "pr"; repo?: string; number?: number; url?: string };

/** Starts a review job. Throws `NeedsRepo` when a PR URL matched no single local clone. */
export class NeedsRepo extends Error {
  constructor(public ownerRepo: string, public candidates: string[]) {
    super(`Pick the local clone of ${ownerRepo}`);
  }
}
export interface WhiteboardStatus {
  registered: boolean;
  running: boolean;
  url?: string;
  error?: string;
}
export const fetchWhiteboardStatus = () => fetch("/api/whiteboard/status").then((r) => json<WhiteboardStatus>(r));
export const openInWhiteboard = (reviewId: string, redraw = false) =>
  fetch(`/api/reviews/${enc(reviewId)}/whiteboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redraw }),
  }).then((r) => json<{ sessionId: string; opened: boolean }>(r));

export type WhiteboardMode = "off" | "draw" | "explain";
export async function startJob(
  scope: StartJobScope,
  model?: string,
  whiteboard: WhiteboardMode = "off",
  task?: string,
  notes?: string,
): Promise<Job> {
  const r = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "review",
      scope,
      ...(model ? { model } : {}),
      ...(whiteboard !== "off" ? { whiteboard } : {}),
      ...(task?.trim() ? { task: task.trim() } : {}),
      ...(notes?.trim() ? { notes: notes.trim() } : {}),
    }),
  });
  if (r.status === 409) {
    const b = (await r.json()) as { needsRepo: { ownerRepo: string; candidates: string[] } };
    throw new NeedsRepo(b.needsRepo.ownerRepo, b.needsRepo.candidates);
  }
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${r.status}`);
  return (await r.json()) as Job;
}

/** Native folder dialog (desktop app). Returns null when cancelled; throws when this build has no dialog. */
export const pickFolder = () => postJson<{ path?: string; cancelled?: boolean }>("/api/pick-folder", {}).then((r) => r.path ?? null);
export const saveFile = (name: string, content: string) =>
  postJson<{ path?: string; cancelled?: boolean }>("/api/save-file", { name, content }).then((r) => r.path ?? null);

export async function importReview(text: string, repo?: string): Promise<Review> {
  const r = await fetch("/api/reviews/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, repo }) });
  if (r.status === 409) {
    const b = (await r.json()) as { needsRepo: { repoName: string; candidates: string[] } };
    throw new NeedsRepo(b.needsRepo.repoName, b.needsRepo.candidates);
  }
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${r.status}`);
  return (await r.json()) as Review;
}

/** Live updates from the server. EventSource reconnects by itself if the server restarts. */
export function subscribe(onEvent: (e: StoreEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as StoreEvent);
  return () => es.close();
}
