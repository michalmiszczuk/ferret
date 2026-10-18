// The git scope engine: turns "what to review" into a checkout + a diff spec.
// All git calls go through execFile with argument arrays; user strings are validated and never become options.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CommitSummary } from "../shared/api-types";
import { isSafeRevision, isSha } from "../shared/git-parse";
import type { ReviewSource } from "../shared/schema";

export { isSafeRevision };

const execFileP = promisify(execFile);

export class ScopeError extends Error {}

export type ScopeInput =
  | { type: "changes"; repo: string }
  | { type: "commit"; repo: string; sha: string }
  | { type: "range"; repo: string; from: string; to: string }
  | { type: "branch"; repo: string; branch: string; base?: string }
  | { type: "pr"; repo: string; number: number; host?: "github" };

export interface ResolvedScope {
  source: ReviewSource;
  checkout: string;
  isWorktree: boolean;
  /** Human-readable git command that shows the reviewed change (for prompts and the chat skill). */
  diffCommand: string;
  /** The same as git arguments, run inside `checkout` (see diffPatch). */
  diffArgs: string[];
  changedFiles: string[];
  label: string;
}

export interface PrInfo {
  number: number;
  title: string;
  author: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  headSha: string;
}
export type PrInfoFn = (repo: string, n: number) => Promise<PrInfo>;

async function git(repo: string, args: string[], opts: { maxBuffer?: number; signal?: AbortSignal } = {}): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", repo, ...args], { maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024, signal: opts.signal });
    return stdout;
  } catch (err) {
    if (opts.signal?.aborted) throw new ScopeError("cancelled");
    const e = err as { stderr?: string; message: string };
    const first = (e.stderr ?? e.message).split(/\r?\n/).find((l) => l.trim()) ?? "git failed";
    throw new ScopeError(first.replace(/^fatal:\s*/i, ""));
  }
}

/** The reviewed change as a patch, produced inside `checkout` (a worktree shares the repo's objects). Truncated at `maxBytes`. */
export async function diffPatch(checkout: string, diffArgs: string[], maxBytes = 2 * 1024 * 1024): Promise<string> {
  const out = await git(checkout, ["-c", "core.pager=cat", ...diffArgs], { maxBuffer: maxBytes * 4 });
  return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n\n[… diff truncated at ${Math.round(maxBytes / 1024)} KB; read the files for the rest]\n` : out;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export function repoNameOf(repo: string): string {
  return path.basename(path.resolve(repo));
}

export async function originUrl(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ["remote", "get-url", "origin"])).trim() || null;
  } catch {
    return null;
  }
}

export async function headSha(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function defaultBranch(repo: string): Promise<string> {
  try {
    const out = (await git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (out) return out.replace(/^origin\//, "");
  } catch {
    // no origin/HEAD
  }
  for (const b of ["main", "master"]) if (await refExists(repo, b)) return b;
  throw new ScopeError("Could not find a default branch (no origin/HEAD, main or master)");
}

export async function validateRef(repo: string, ref: string): Promise<boolean> {
  if (!ref || ref.startsWith("-")) return false;
  try {
    await execFileP("git", ["-C", repo, "check-ref-format", "--branch", ref]);
    return true;
  } catch {
    return false;
  }
}

export async function listBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]);
  return out.split(/\r?\n/).filter(Boolean);
}

export async function listCommits(repo: string, limit = 50): Promise<CommitSummary[]> {
  const sep = "\u001f";
  const out = await git(repo, ["log", `-n${limit}`, `--format=%H${sep}%h${sep}%s${sep}%an${sep}%cr`]);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [sha, short, subject, author, date] = l.split(sep);
      return { sha, short, subject, author, date };
    });
}

async function resolveSha(repo: string, ref: string, what: string): Promise<string> {
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
  } catch {
    throw new ScopeError(`invalid ${what} ${ref}`);
  }
}

async function nameOnly(repo: string, args: string[]): Promise<string[]> {
  const out = await git(repo, args);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function subjectOf(repo: string, sha: string): Promise<string> {
  return (await git(repo, ["log", "-1", "--format=%s", sha])).trim();
}

// ---- worktrees ----

export function worktreePath(worktreesDir: string, repo: string, head: string): string {
  return path.join(worktreesDir, `${repoNameOf(repo)}-${head.slice(0, 7)}`);
}

/** A detached worktree at `head`, created under worktreesDir or reused when it already exists. */
export async function ensureWorktree(repo: string, head: string, worktreesDir: string, signal?: AbortSignal): Promise<string> {
  const dir = worktreePath(worktreesDir, repo, head);
  if (await fs.stat(path.join(dir, ".git")).then(() => true, () => false)) {
    // Reuse only if it is still registered with this repo; otherwise recreate.
    const list = await git(repo, ["worktree", "list", "--porcelain"]);
    if (list.replace(/\\/g, "/").toLowerCase().includes(dir.replace(/\\/g, "/").toLowerCase())) return dir;
    await fs.rm(dir, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]);
  } else if (await fs.stat(dir).then(() => true, () => false)) {
    await fs.rm(dir, { recursive: true, force: true }); // leftover of an interrupted add
    await git(repo, ["worktree", "prune"]);
  }
  await fs.mkdir(worktreesDir, { recursive: true });
  try {
    await git(repo, ["worktree", "add", "--detach", "--", dir, head], { signal });
  } catch (err) {
    if (signal?.aborted) await removeWorktree(repo, dir); // no partial snapshots
    throw err;
  }
  return dir;
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  try {
    await git(repo, ["worktree", "remove", "--force", "--", dir]);
  } catch {
    await fs.rm(dir, { recursive: true, force: true });
  }
  try {
    await git(repo, ["worktree", "prune"]);
  } catch {
    // repo may be gone
  }
}

export async function listFerretWorktrees(worktreesDir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(worktreesDir);
    return names.map((n) => path.join(worktreesDir, n));
  } catch {
    return [];
  }
}

/** The main repo a worktree belongs to, read from its `.git` pointer file (`gitdir: <repo>/.git/worktrees/<name>`). */
export async function repoOfWorktree(dir: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path.join(dir, ".git"), "utf8");
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return undefined;
    const gitdir = path.resolve(dir, m[1]);
    // <repo>/.git/worktrees/<name> → <repo>
    return path.dirname(path.dirname(path.dirname(gitdir)));
  } catch {
    return undefined;
  }
}

export const normPath = (p: string): string => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Removes every Ferret worktree under `worktreesDir` that is not in `keep`. Returns the removed paths. */
export async function sweepWorktrees(worktreesDir: string, keep: Iterable<string>): Promise<string[]> {
  const kept = new Set([...keep].map(normPath));
  const removed: string[] = [];
  for (const dir of await listFerretWorktrees(worktreesDir)) {
    if (kept.has(normPath(dir))) continue;
    const repo = await repoOfWorktree(dir);
    if (repo) await removeWorktree(repo, dir);
    else await fs.rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

// ---- resolve ----

export async function resolveScope(
  input: ScopeInput,
  deps: { worktreesDir: string; prInfo?: PrInfoFn; signal?: AbortSignal },
): Promise<ResolvedScope> {
  const repo = path.resolve(input.repo);
  if (!(await isGitRepo(repo))) throw new ScopeError(`not a git repo: ${input.repo}`);
  const repoName = repoNameOf(repo);
  const currentHead = await headSha(repo);

  const finish = async (
    partial: Omit<ReviewSource, "repoName" | "repo" | "checkout" | "worktree">,
    diffArgs: string[],
    changedFiles: string[],
    label: string,
  ): Promise<ResolvedScope> => {
    const needsWorktree = partial.kind !== "changes" && partial.head !== currentHead;
    const checkout = needsWorktree ? await ensureWorktree(repo, partial.head, deps.worktreesDir, deps.signal) : repo;
    return {
      source: { ...partial, repoName, repo, checkout, worktree: needsWorktree },
      checkout,
      isWorktree: needsWorktree,
      diffCommand: `git ${diffArgs.join(" ")}`,
      diffArgs,
      changedFiles,
      label,
    };
  };

  switch (input.type) {
    case "changes": {
      const changed = await nameOnly(repo, ["diff", "--name-only", "HEAD"]);
      const untracked = await nameOnly(repo, ["ls-files", "--others", "--exclude-standard"]);
      return finish({ kind: "changes", head: currentHead }, ["diff", "HEAD"], [...new Set([...changed, ...untracked])], "uncommitted changes");
    }
    case "commit": {
      if (!isSha(input.sha) && !isSafeRevision(input.sha)) throw new ScopeError(`invalid commit ${input.sha}`);
      const head = await resolveSha(repo, input.sha, "commit");
      const base = await resolveSha(repo, `${head}^`, "commit").catch(() => undefined);
      const title = await subjectOf(repo, head);
      const changed = await nameOnly(repo, ["show", "--name-only", "--format=", head]);
      return finish({ kind: "commit", head, base, title }, ["show", head], changed, `commit ${head.slice(0, 7)} · ${title}`);
    }
    case "range": {
      if (!isSafeRevision(input.from)) throw new ScopeError(`invalid ref ${input.from}`);
      if (!isSafeRevision(input.to)) throw new ScopeError(`invalid ref ${input.to}`);
      const from = await resolveSha(repo, input.from, "ref");
      const to = await resolveSha(repo, input.to, "ref");
      const changed = await nameOnly(repo, ["diff", "--name-only", `${from}...${to}`]);
      return finish({ kind: "range", head: to, base: from }, ["diff", `${from}...${to}`], changed, `${input.from}..${input.to}`);
    }
    case "branch": {
      if (!(await validateRef(repo, input.branch))) throw new ScopeError(`invalid ref ${input.branch}`);
      const baseName = input.base ?? (await defaultBranch(repo));
      if (!(await validateRef(repo, baseName))) throw new ScopeError(`invalid ref ${baseName}`);
      const head = await resolveSha(repo, input.branch, "ref");
      const base = await resolveSha(repo, baseName, "ref");
      const changed = await nameOnly(repo, ["diff", "--name-only", `${base}...${head}`]);
      return finish({ kind: "branch", head, base: baseName, branch: input.branch }, ["diff", `${base}...${head}`], changed, `${input.branch} vs ${baseName}`);
    }
    case "pr": {
      if (!deps.prInfo) throw new ScopeError("GitHub CLI isn't available/logged in. Install it and run `gh auth login`, or review by branch instead.");
      const pr = await deps.prInfo(repo, input.number);
      if (!(await validateRef(repo, pr.baseRefName))) throw new ScopeError(`invalid ref ${pr.baseRefName}`);
      try {
        await git(repo, ["fetch", "--quiet", "origin", `pull/${input.number}/head`, pr.baseRefName], { signal: deps.signal });
      } catch (err) {
        if (deps.signal?.aborted) throw err;
        throw new ScopeError(`Fetch failed: ${(err as Error).message}`);
      }
      const head = (await git(repo, ["rev-parse", "FETCH_HEAD"])).trim(); // FETCH_HEAD = first refspec = PR head
      const baseRef = `origin/${pr.baseRefName}`;
      const base = await resolveSha(repo, baseRef, "ref");
      const changed = await nameOnly(repo, ["diff", "--name-only", `${base}...${head}`]);
      return finish(
        { kind: "pr", host: "github", url: pr.url, number: pr.number, title: pr.title, author: pr.author, head, base: baseRef, branch: pr.headRefName },
        ["diff", `${base}...${head}`],
        changed,
        `PR #${pr.number} · ${repoName} · ${pr.title}`,
      );
    }
  }
}
