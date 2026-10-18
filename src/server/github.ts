// GitHub lookups through the `gh` CLI (already installed and logged in on the user's machine).
import { execFile } from "node:child_process";
import type { PrSummary } from "../shared/api-types";
import type { PrInfo } from "./scope";

export type Exec = (file: string, args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string; code: number }>;

export class GithubError extends Error {}

export const GH_UNAVAILABLE =
  "GitHub CLI isn't available/logged in. Install it and run `gh auth login`, or review by branch instead.";

const defaultExec: Exec = (file, args, cwd) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === "ENOENT" ? -1 : (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1)) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export function createGithub(exec: Exec = defaultExec) {
  async function run(args: string[], cwd?: string): Promise<string> {
    const r = await exec("gh", args, cwd);
    if (r.code === -1) throw new GithubError(GH_UNAVAILABLE);
    if (r.code !== 0) {
      const first = r.stderr.split(/\r?\n/).find((l) => l.trim()) ?? "gh failed";
      if (/auth login|not logged|authentication/i.test(first)) throw new GithubError(GH_UNAVAILABLE);
      throw new GithubError(first);
    }
    return r.stdout;
  }

  return {
    async status(): Promise<{ installed: boolean; loggedIn: boolean; user?: string }> {
      const auth = await exec("gh", ["auth", "status"]);
      if (auth.code === -1) return { installed: false, loggedIn: false };
      // `gh auth status` exits 1 when ANY stored account is broken, even if the active one works.
      // The active account is what matters: ask the API who we are.
      const who = await exec("gh", ["api", "user", "--jq", ".login"]);
      const user = who.code === 0 ? who.stdout.trim() : "";
      return { installed: true, loggedIn: Boolean(user), user: user || undefined };
    },

    async prInfo(repo: string, n: number): Promise<PrInfo> {
      const out = await run(
        ["pr", "view", String(n), "--json", "number,title,author,url,headRefName,baseRefName,headRefOid"],
        repo,
      );
      const j = JSON.parse(out) as {
        number: number; title: string; author?: { login?: string }; url: string; headRefName: string; baseRefName: string; headRefOid: string;
      };
      return {
        number: j.number,
        title: j.title,
        author: j.author?.login ?? "",
        url: j.url,
        headRefName: j.headRefName,
        baseRefName: j.baseRefName,
        headSha: j.headRefOid,
      };
    },

    async listPrs(repo: string): Promise<PrSummary[]> {
      const out = await run(["pr", "list", "--limit", "30", "--json", "number,title,author,updatedAt,url,headRefName"], repo);
      const list = JSON.parse(out) as { number: number; title: string; author?: { login?: string }; updatedAt: string; url: string; headRefName: string }[];
      return list
        .map((p) => ({ number: p.number, title: p.title, author: p.author?.login ?? "", updatedAt: p.updatedAt, url: p.url, headRefName: p.headRefName }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}

export type Github = ReturnType<typeof createGithub>;
