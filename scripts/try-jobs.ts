// Dev helper: exercises the job manager with a fake runner and a fake scope resolver (no git, no Claude).
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobManager } from "../src/server/jobs";
import { buildReviewRun } from "../src/server/prompts";
import type { ResolvedScope } from "../src/server/scope";
import { ReviewStore } from "../src/server/store";
import type { RunHandle, RunOptions, RunResult } from "../src/server/claude-runner";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-jobs-"));
const store = new ReviewStore(path.join(home, "reviews"), () => {});
await store.load();

const scope = (worktree: boolean): ResolvedScope => ({
  source: { kind: "commit", repoName: "r", repo: "C:/r", head: "abcdef1234567", base: "0000000", checkout: worktree ? "C:/wt" : "C:/r", worktree },
  checkout: worktree ? "C:/wt" : "C:/r",
  isWorktree: worktree,
  diffCommand: "git show abcdef1",
  diffArgs: ["show", "abcdef1"],
  changedFiles: ["a.ts"],
  label: "commit abcdef1 · test",
});

const running: string[] = [];
let delay = 150;
const fakeRunner = (o: RunOptions): RunHandle => {
  const h = new EventEmitter() as RunHandle;
  const tag = o.outputFormat === "json" ? "draft" : "review";
  running.push(`start:${tag}`);
  h.done = new Promise<RunResult>((resolve) =>
    setTimeout(() => {
      running.push(`end:${tag}`);
      resolve({ ok: true, exitCode: 0, resultText: tag === "draft" ? "Nice catch, consider X." : "", isError: false, logTail: [], cancelled: false, timedOut: false });
    }, delay),
  );
  h.cancel = () => {};
  return h;
};

const jobs = new JobManager({ store, home, mcpUrl: "http://127.0.0.1:4477/mcp", rules: "RULES", runner: fakeRunner, resolveScope: async () => scope(false) });
await jobs.load();

const run = buildReviewRun(scope(true), "j_x", { rules: "RULES", mcpUrl: "u", sandboxDir: "C:/sandbox" });
console.log("worktree run → cwd:", run.cwd, "| addDirs:", run.addDirs, "| tools:", run.allowedTools.length);
console.log("own-repo run → cwd:", buildReviewRun(scope(false), "j_x", { rules: "RULES", mcpUrl: "u", sandboxDir: "C:/sandbox" }).cwd);
console.log("prompt mentions jobId:", run.prompt.includes('jobId: "j_x"'), "| diff:", run.prompt.includes("git show abcdef1"));

const a = jobs.startReview({ type: "commit", repo: "C:/r", sha: "abcdef1" });
const b = jobs.startReview({ type: "commit", repo: "C:/r", sha: "abcdef1" });
await new Promise((r) => setTimeout(r, 50));
console.log("second review queued while first runs:", jobs.get(a.id)!.status, jobs.get(b.id)!.status);
await new Promise((r) => setTimeout(r, 400));
console.log("both done:", jobs.get(a.id)!.status, jobs.get(b.id)!.status, "| order:", running.join(" "));
console.log("empty review created for a (no submit):", Boolean(jobs.get(a.id)!.reviewId), "| note:", jobs.get(a.id)!.note);
const review = store.get(jobs.get(a.id)!.reviewId!)!;
console.log("review source kind:", review.source?.kind, "| findings:", review.findings.length);

// a draft runs alongside a review
running.length = 0;
const r2 = await store.create({ repoRoot: "C:/r", scope: { kind: "files", target: ["a.ts"] }, summary: "s", findings: [{ severity: "high", title: "T", body: "B", category: "bug", file: "a.ts", lineStart: 1, lineEnd: 1, snippet: "x" }] });
delay = 300;
const rev = jobs.startReview({ type: "commit", repo: "C:/r", sha: "abcdef1" });
delay = 100;
const d = jobs.startDraft(r2.id, "f1");
await new Promise((r) => setTimeout(r, 200));
console.log("draft finished while review still running:", jobs.get(d.id)!.status, jobs.get(rev.id)!.status, "| draft text:", store.get(r2.id)!.findings[0].draft);
await new Promise((r) => setTimeout(r, 300));

// persisted history; a running job becomes cancelled on load
const raw = JSON.parse(await fs.readFile(path.join(home, "jobs.json"), "utf8"));
raw[0].status = "running";
await fs.writeFile(path.join(home, "jobs.json"), JSON.stringify(raw));
const jobs2 = new JobManager({ store, home, mcpUrl: "u", rules: "R" });
await jobs2.load();
console.log("after reload, the 'running' job is:", jobs2.list().find((j) => j.id === raw[0].id)!.status);

// scope registry
const sid = jobs.registerScope(scope(false));
console.log("scope registered and taken once:", Boolean(jobs.takeScope(sid)), jobs.takeScope(sid) === undefined);
console.log("cancel a queued job:", await (async () => { delay = 1000; const x = jobs.startReview({ type: "changes", repo: "C:/r" }); const y = jobs.startReview({ type: "changes", repo: "C:/r" }); await jobs.cancel(y.id); return `${jobs.get(y.id)!.status} (x ${jobs.get(x.id)!.status})`; })());
process.exit(0);
