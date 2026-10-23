import type { Review, Severity } from "./schema";

export interface CommitSummary {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string; // relative, e.g. "3 days ago"
}

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  updatedAt: string;
  url: string;
  headRefName: string;
}

export type JobKind = "review" | "draft" | "draft-all";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  label: string;
  scope?: unknown; // ScopeInput (server type); the UI only displays `label`
  reviewId?: string;
  findingId?: string;
  /** Model id the job runs on (reviews). */
  model?: string;
  /** Whiteboard: "draw" = draw the findings when done; "explain" = Claude explains the change on Whiteboard first, the review uses it as its map, findings are added to the same document. */
  whiteboard?: "draw" | "explain";
  /** ClickUp task link/id the change implements; its description and comments are given to the reviewer. */
  task?: string;
  taskName?: string;
  /** Context for the reviewer, e.g. handed over by a Claude chat via the start_review tool. */
  notes?: string;
  /** The latest activity line (what Claude is doing right now). */
  progress?: string;
  /** Coarse stage of a review job: "Fetching the pull request", "Preparing the snapshot", "Reviewing", "Submitting". */
  phase?: string;
  /** The last few activity lines, oldest first (live feed on the job card). */
  activity?: string[];
  /** Tool calls so far and distinct files read. */
  stats?: { tools: number; files: number };
  error?: string;
  logTail: string[];
  note?: string;
}

export interface EnvStatus {
  gh: { installed: boolean; loggedIn: boolean; user?: string };
  claude: { installed: boolean; version?: string };
  git: { installed: boolean };
}

export interface ClaudeStatus {
  connected: boolean;
  skillsInstalled: boolean;
  skillsOutdated?: boolean; // installed skills are older than the app's → offer "Update Claude"
  mcpRegistered: boolean;
}

export interface ClaudeConnectResult {
  ok: boolean;
  message: string;
}

export type StoreEvent =
  | { type: "review-created" | "review-updated" | "review-deleted"; reviewId: string }
  | { type: "job-updated"; jobId: string }
  | { type: "proposal-created" | "proposal-updated" | "proposal-deleted"; proposalId: string };

/** Proposal mode (see shared/proposal.ts): list entry and a step as the UI sees it. */
export interface ProposalSummary {
  id: string;
  title: string;
  status: "active" | "done";
  createdAt: string;
  progress: { applied: number; total: number };
}
export type StepView = import("./proposal").Step & { stale: boolean; blocked: boolean; blockedBy: string[] };

export type Anchor = { lineStart: number; lineEnd: number; anchor: "exact" | "moved" | "lost" };

export type FileResponse =
  | { exists: false }
  | { exists: true; content: string; changedLines: number[]; anchors: Record<string, Anchor> };

export interface ReviewSummary {
  id: string;
  createdAt: string;
  repoName: string;
  scope: Review["scope"];
  counts: Record<Severity, number>;
  pending: number; // findings with status fix_requested
  total: number;
  label: string; // "PR #218 · repo · title" or "repo · uncommitted changes"
}
