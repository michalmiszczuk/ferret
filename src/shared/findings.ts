import type { ReviewSummary } from "./api-types";
import { sourceLabel } from "./git-parse";
import { repoName } from "./paths";
import type { Finding, FindingStatus, Review, Scope, Severity } from "./schema";

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const SEVERITY_ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };

const DONE: ReadonlySet<FindingStatus> = new Set(["fixed", "skipped", "dismissed"]);

export function isDone(f: Finding): boolean {
  return DONE.has(f.status);
}

export function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.lineStart - b.lineStart,
  );
}

export type StatusFilter = "all" | "open" | "done";
export interface Filters {
  severities: Severity[];
  status: StatusFilter;
}

export function filterFindings(fs: Finding[], filters: Filters): Finding[] {
  return fs.filter(
    (f) =>
      filters.severities.includes(f.severity) &&
      (filters.status === "all" || (filters.status === "done") === isDone(f)),
  );
}

export function listView(fs: Finding[], filters: Filters): { active: Finding[]; done: Finding[] } {
  const sorted = sortFindings(filterFindings(fs, filters));
  return { active: sorted.filter((f) => !isDone(f)), done: sorted.filter(isDone) };
}

/** The order j/k keyboard navigation walks: what is visible in the list, top to bottom. */
export function navOrder(fs: Finding[], filters: Filters, doneOpen: boolean): Finding[] {
  const { active, done } = listView(fs, filters);
  return [...active, ...(doneOpen || filters.status === "done" ? done : [])];
}

export function countBySeverity(fs: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of fs) counts[f.severity]++;
  return counts;
}

export function scopeLabel(scope: Scope): string {
  return scope.kind === "diff" ? "uncommitted changes" : scope.target.join(", ");
}

export function toSummary(r: Review): ReviewSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    repoName: repoName(r.repoRoot),
    label: r.source ? sourceLabel(r.source) : `${repoName(r.repoRoot)} · ${scopeLabel(r.scope)}`,
    scope: r.scope,
    counts: countBySeverity(r.findings),
    pending: r.findings.filter((f) => f.status === "fix_requested").length,
    total: r.findings.length,
  };
}
