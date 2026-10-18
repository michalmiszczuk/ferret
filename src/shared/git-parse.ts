// Pure git/PR string helpers (no node imports; the UI uses them too).
import type { ReviewSource } from "./schema";

export type PrHost = "github" | "bitbucket";

/** `https://github.com/a/b/pull/218[/files]` or `https://bitbucket.org/a/b/pull-requests/42[/…]`. */
export function parsePrUrl(url: string): { host: PrHost; ownerRepo: string; number: number } | null {
  const m = url.trim().match(/^https?:\/\/(?:www\.)?(github\.com|bitbucket\.org)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/(pull|pull-requests)\/(\d+)(?:[/?#]|$)/i);
  if (!m) return null;
  const host: PrHost = m[1].toLowerCase() === "github.com" ? "github" : "bitbucket";
  if ((host === "github") !== (m[4] === "pull")) return null;
  return { host, ownerRepo: `${m[2]}/${m[3]}`, number: Number(m[5]) };
}

/** `https://github.com/a/b.git`, `git@github.com:a/b.git`, `ssh://git@bitbucket.org/a/b` → `a/b`. */
export function ownerRepoFromOrigin(originUrl: string): string | null {
  const s = originUrl.trim();
  const m =
    s.match(/^[a-z+]+:\/\/[^/]+\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i) ?? // https://host/a/b(.git), ssh://user@host/a/b
    s.match(/^[^@\s]+@[^:\s]+:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i); // git@host:a/b(.git)
  return m ? `${m[1]}/${m[2]}` : null;
}

export function originMatches(originUrl: string, ownerRepo: string): boolean {
  const a = ownerRepoFromOrigin(originUrl);
  return a !== null && a.toLowerCase() === ownerRepo.replace(/\.git$/i, "").toLowerCase();
}

export function isSha(s: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(s.trim());
}

/** A revision expression we are willing to hand to git as a positional argument (HEAD~3, v1.2, a1b2c3, origin/main): no option-like or range forms. */
export function isSafeRevision(s: string): boolean {
  return /^[^\s-][^\s]*$/.test(s) && !s.includes("..");
}

/** `a..b` or `a...b` → { from, to }. */
export function parseRange(s: string): { from: string; to: string } | null {
  const m = s.trim().match(/^([^\s.]+(?:\.[^\s.]+)*?)\.{2,3}([^\s.]+(?:\.[^\s.]+)*)$/);
  return m ? { from: m[1], to: m[2] } : null;
}

/** One-line description of what a review looked at, for headers and the switcher. */
export function sourceLabel(source: ReviewSource): string {
  const short = source.head.slice(0, 7);
  switch (source.kind) {
    case "pr":
      return `PR #${source.number ?? "?"} · ${source.repoName}${source.title ? ` · ${source.title}` : ""}`;
    case "commit":
      return `commit ${short}${source.title ? ` · ${source.title}` : ""}`;
    case "range":
      return `${(source.base ?? "?").slice(0, 7)}..${short}`;
    case "branch":
      return `${source.branch ?? short} vs ${source.base ?? "?"}`;
    case "changes":
      return "uncommitted changes";
  }
}
