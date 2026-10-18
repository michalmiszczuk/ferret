// Turns a portable review (from another Ferret) into a stored review against the importer's clone.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PortableReview } from "../shared/export";
import type { Review, ReviewSource } from "../shared/schema";
import { ensureWorktree, headSha, isGitRepo, repoNameOf, ScopeError } from "./scope";
import type { ReviewStore } from "./store";

const execFileP = promisify(execFile);

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  try {
    await execFileP("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function importReview(
  p: PortableReview,
  repo: string,
  deps: { store: ReviewStore; worktreesDir: string; by?: string },
): Promise<Review> {
  if (!(await isGitRepo(repo))) throw new ScopeError(`not a git repo: ${repo}`);
  let repoRoot = repo;
  let source: ReviewSource | undefined;
  if (p.source) {
    // Open at the reviewed commit when the clone has it; otherwise on the current files (snippets re-anchor).
    const available = await hasCommit(repo, p.source.head);
    const current = await headSha(repo);
    const useWorktree = available && current !== p.source.head;
    if (useWorktree) repoRoot = await ensureWorktree(repo, p.source.head, deps.worktreesDir);
    source = { ...p.source, repoName: repoNameOf(repo), repo, checkout: repoRoot, worktree: useWorktree };
  }
  const review = await deps.store.create(
    {
      repoRoot,
      scope: p.scope,
      summary: p.summary,
      findings: p.findings.map(({ id: _id, originalSeverity: _o, status: _s, updatedAt: _u, myNote: _n, resolution: _r, draft: _d, ...f }) => f),
    },
    { source, imported: { by: deps.by ?? p.imported?.by, at: new Date().toISOString() } },
  );
  // Carry over triage state, notes and drafts (create() reset them).
  for (let i = 0; i < p.findings.length; i++) {
    const src = p.findings[i];
    const dst = review.findings[i];
    const patch = {
      status: src.status,
      severity: src.severity,
      ...(src.myNote ? { myNote: src.myNote } : {}),
      ...(src.resolution ? { resolution: src.resolution } : {}),
      ...(src.draft ? { draft: src.draft } : {}),
    };
    await deps.store.updateFinding(review.id, dst.id, patch);
  }
  return deps.store.get(review.id)!;
}
