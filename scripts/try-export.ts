// Dev helper: export a review from a throwaway server, then import it into a second throwaway server.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/index";
import { listCommits } from "../src/server/scope";
import { parseExport } from "../src/shared/export";

const repo = process.cwd();
const mk = async (tag: string) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `ferret-${tag}-`));
  return startServer({ port: 0, home, log: () => {}, skillsDir: path.resolve("skills") });
};
const a = await mk("export");
const older = (await listCommits(repo, 2))[1].sha;
const review = await a.store.create(
  {
    repoRoot: repo,
    scope: { kind: "files", target: ["package.json"] },
    summary: "A review to export.",
    findings: [
      { severity: "high", title: "Version pinned oddly", body: "The **version** field looks hand-edited.", category: "maintainability", file: "package.json", lineStart: 3, lineEnd: 3, snippet: '  "version": "0.1.0",', suggestion: "Use `npm version`." },
      { severity: "low", title: "Nit in README", body: "Tiny nit.", category: "style", file: "README.md", lineStart: 1, lineEnd: 1, snippet: "# Ferret 🦦" },
    ],
  },
  { source: { kind: "commit", repoName: "review-app", repo, head: older, base: `${older}^`, title: "older commit", checkout: repo, worktree: false } },
);
await a.store.updateFinding(review.id, "f1", { draft: "Could you run `npm version` instead of editing by hand?" });
await a.store.updateFinding(review.id, "f2", { status: "dismissed" });

const res = await fetch(`${a.url}/api/reviews/${review.id}/export`);
const md = await res.text();
console.log("export:", res.status, res.headers.get("content-type"), res.headers.get("content-disposition"));
console.log("--- first 25 lines ---\n" + md.split("\n").slice(0, 25).join("\n") + "\n---");
console.log("contains local path:", md.includes(repo.replace(/\\/g, "/")) || md.includes(repo), "| has Reply:", md.includes("**Reply**"), "| has Dismissed:", md.includes("## Dismissed"));
const parsed = parseExport(md);
console.log("parse:", parsed.ok ? `ok, ${parsed.review.findings.length} findings, source ${parsed.review.source?.kind}` : parsed.error);

const b = await mk("import");
const post = (p: string, body: unknown) => fetch(`${b.url}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const noRepo = await post("/api/reviews/import", { text: md });
console.log("import without repo →", noRepo.status, await noRepo.json());
const withRepo = await post("/api/reviews/import", { text: md, repo });
const imported = await withRepo.json();
console.log("import with repo →", withRepo.status, { worktree: imported.source?.worktree, repoRoot: imported.repoRoot, imported: imported.imported, f1draft: imported.findings[0].draft?.slice(0, 20), f2status: imported.findings[1].status });
const file = await (await fetch(`${b.url}/api/reviews/${imported.id}/file?path=package.json`)).json();
console.log("file at imported commit: exists", file.exists, "| anchor f1:", file.anchors?.f1);

// unknown head: the clone doesn't have the commit → opens on current files
const md2 = md.replaceAll(older, "0123456789abcdef0123456789abcdef01234567").replaceAll(older.slice(0, 12), "0123456789ab");
const unknown = await (await post("/api/reviews/import", { text: md2, repo })).json();
console.log("import with unknown head →", { worktree: unknown.source?.worktree, repoRoot: unknown.repoRoot === repo ? "(repo)" : unknown.repoRoot });
await a.close();
await b.close();
process.exit(0);
