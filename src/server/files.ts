import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Anchor } from "../shared/api-types";

const execFileP = promisify(execFile);

export class PathError extends Error {}

function ensureInside(root: string, target: string, rel: string): void {
  const r = path.relative(root, target);
  if (r === "" || r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) {
    throw new PathError(`Path is outside the repository: ${rel}`);
  }
}

/**
 * Validates the repoRoot Claude sent: must be an absolute, existing directory. On Windows a Git Bash
 * style path (/c/Users/...) is converted to C:\Users\..., because that is what `pwd` prints there.
 */
export async function normalizeRepoRoot(root: string): Promise<string> {
  let r = root.trim();
  if (process.platform === "win32") r = r.replace(/^\/([a-zA-Z])(?=\/|$)/, (_m, d: string) => `${d.toUpperCase()}:`);
  const ok = path.isAbsolute(r) && (await fs.stat(r).then((s) => s.isDirectory(), () => false));
  if (!ok) {
    throw new Error(`repoRoot "${root}" is not an existing directory. Pass the absolute path of the repository (e.g. C:\\Users\\me\\project).`);
  }
  return path.resolve(r);
}

/** Resolves a repo-relative path, refusing anything (incl. symlinks/junctions) that lands outside repoRoot. */
export async function resolveInRepo(repoRoot: string, rel: string): Promise<{ abs: string; exists: boolean }> {
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new PathError(`Invalid path: ${rel}`);
  }
  const rootReal = await fs.realpath(repoRoot).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new PathError(`repoRoot not found: ${repoRoot}`);
    throw err;
  });
  const abs = path.resolve(rootReal, rel);
  ensureInside(rootReal, abs, rel);
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { abs, exists: false };
    throw err;
  }
  ensureInside(rootReal, real, rel);
  return { abs: real, exists: true };
}

export async function readRepoFile(
  repoRoot: string,
  rel: string,
): Promise<{ exists: false } | { exists: true; content: string }> {
  const { abs, exists } = await resolveInRepo(repoRoot, rel);
  if (!exists) return { exists: false };
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new PathError(`Not a file: ${rel}`);
  return { exists: true, content: await fs.readFile(abs, "utf8") };
}

export function splitLines(s: string): string[] {
  return s.split(/\r?\n/);
}

export function parseDiffNewLines(diff: string): number[] {
  const out: number[] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) out.push(start + i);
  }
  return out;
}

/** Lines of `rel` that differ from HEAD. Untracked file → every line. Not a git repo / any git error → []. */
export async function changedLines(repoRoot: string, rel: string, totalLines: number): Promise<number[]> {
  try {
    const { stdout: untracked } = await execFileP(
      "git", ["ls-files", "--others", "--exclude-standard", "--", rel], { cwd: repoRoot },
    );
    if (untracked.trim()) return Array.from({ length: totalLines }, (_, i) => i + 1);
    const { stdout } = await execFileP(
      "git", ["diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD", "--", rel],
      { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 },
    );
    return parseDiffNewLines(stdout);
  } catch {
    return [];
  }
}

/** Finds where a finding's snippet lives in the current file. Comparison ignores leading/trailing whitespace per line. */
export function reanchor(content: string, f: { lineStart: number; lineEnd: number; snippet: string }): Anchor {
  const fileLines = splitLines(content).map((l) => l.trim());
  const snip = splitLines(f.snippet).map((l) => l.trim());
  while (snip.length > 1 && snip[snip.length - 1] === "") snip.pop();
  while (snip.length > 1 && snip[0] === "") snip.shift();
  const n = snip.length;

  const matchesAt = (i: number): boolean => {
    if (i < 0 || i + n > fileLines.length) return false;
    for (let k = 0; k < n; k++) if (fileLines[i + k] !== snip[k]) return false;
    return true;
  };

  const orig = f.lineStart - 1;
  if (matchesAt(orig)) return { lineStart: f.lineStart, lineEnd: f.lineStart + n - 1, anchor: "exact" };

  let best = -1;
  for (let i = 0; i + n <= fileLines.length; i++) {
    if (matchesAt(i) && (best === -1 || Math.abs(i - orig) < Math.abs(best - orig))) best = i;
  }
  if (best === -1) return { lineStart: f.lineStart, lineEnd: f.lineEnd, anchor: "lost" };
  return { lineStart: best + 1, lineEnd: best + n, anchor: "moved" };
}

export async function anchorFinding(
  repoRoot: string,
  f: { file: string; lineStart: number; lineEnd: number; snippet: string },
): Promise<Anchor & { exists: boolean }> {
  const lost = { lineStart: f.lineStart, lineEnd: f.lineEnd, anchor: "lost" as const, exists: false };
  try {
    const file = await readRepoFile(repoRoot, f.file);
    if (!file.exists) return lost;
    return { ...reanchor(file.content, f), exists: true };
  } catch {
    return lost;
  }
}
