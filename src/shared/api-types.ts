import type { Review, Severity } from "./schema";

export type StoreEvent = { type: "review-created" | "review-updated"; reviewId: string };

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
}
