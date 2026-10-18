// Dev helper: runs a review job end to end on a throwaway server, with the fake claude by default.
// Usage: npx tsx scripts/try-review.ts [--mode submit|ok|error|real] [--repo <path>] [--scope changes|older-commit|range]
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/index";
import { listCommits } from "../src/server/scope";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const mode = arg("mode", "submit");
const repo = path.resolve(arg("repo", process.cwd()));
const scopeKind = arg("scope", "older-commit");

const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-review-"));
const fakeLog = path.join(home, "fake-claude-log.json");
if (mode !== "real") {
  process.env.FAKE_CLAUDE_MODE = mode;
  process.env.FAKE_CLAUDE_LOG = fakeLog;
}
const srv = await startServer({
  port: 0,
  home,
  log: (m) => console.log("  [server]", m),
  skillsDir: path.resolve("skills"),
  claudePath: mode === "real" ? undefined : path.resolve("tests/fake-claude/claude.cjs"),
});
console.log(`server ${srv.url}, home ${home}, mode ${mode}`);

const json = async (p: string, init?: RequestInit) => {
  const r = await fetch(srv.url + p, init);
  return { status: r.status, body: await r.json() };
};
const post = (p: string, body: unknown) => json(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

console.log("env:", (await json("/api/env")).body);

let scope: Record<string, unknown>;
if (scopeKind === "changes") scope = { type: "changes", repo };
else if (scopeKind === "range") scope = { type: "range", repo, from: "HEAD~2", to: "HEAD" };
else scope = { type: "commit", repo, sha: (await listCommits(repo, 2))[1].sha };

const events: string[] = [];
const es = await fetch(`${srv.url}/api/events`);
const reader = es.body!.getReader();
void (async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const l of dec.decode(value).split("\n")) if (l.startsWith("data:")) events.push(JSON.parse(l.slice(5)).type);
  }
})();

const started = await post("/api/jobs", { kind: "review", scope });
console.log("POST /api/jobs →", started.status, started.body.id, started.body.status);
const jobId = started.body.id as string;
let job = started.body;
const t0 = Date.now();
while (!["done", "failed", "cancelled"].includes(job.status) && Date.now() - t0 < (mode === "real" ? 15 * 60_000 : 30_000)) {
  await new Promise((r) => setTimeout(r, 500));
  const next = (await json(`/api/jobs/${jobId}`)).body;
  if (next.progress !== job.progress || next.status !== job.status) console.log(`  ${next.status} ${next.progress ?? ""}`);
  job = next;
}
console.log("job:", { status: job.status, reviewId: job.reviewId, note: job.note, error: job.error, label: job.label, phase: job.phase, stats: job.stats, activity: job.activity });
console.log("SSE types seen:", [...new Set(events)]);

if (job.reviewId) {
  const review = srv.store.get(job.reviewId)!;
  console.log("review:", { kind: review.source?.kind, worktree: review.source?.worktree, repoRoot: review.repoRoot, findings: review.findings.length, summary: review.summary.slice(0, 60) });
  const file = review.findings[0]?.file ?? (scope.type === "changes" ? "package.json" : "README.md");
  const f = await json(`/api/reviews/${review.id}/file?path=${encodeURIComponent(file)}`);
  console.log(`file ${file}:`, f.status, f.body.exists ? `${f.body.content.split("\n").length} lines, changedLines ${JSON.stringify(f.body.changedLines.slice(0, 8))}` : "missing");
}
if (mode !== "real") {
  try {
    const seen = JSON.parse(await fs.readFile(fakeLog, "utf8"));
    const addDir = seen.argv[seen.argv.indexOf("--add-dir") + 1];
    console.log("fake claude saw: cwd =", seen.cwd, "| --add-dir =", addDir, "| env ELECTRON_RUN_AS_NODE/CLAUDECODE =", seen.env);
  } catch {
    console.log("(fake claude did not run)");
  }
}
if (job.status === "failed") console.log("log tail:", job.logTail.slice(-3));
await srv.close();
process.exit(0);
