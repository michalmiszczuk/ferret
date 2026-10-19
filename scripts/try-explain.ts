// Dev helper: the "explain first" pipeline for real — Claude draws the change on Whiteboard, the review reads it
// as its map, findings are added to the same Whiteboard. Needs Whiteboard running and real claude (2 runs).
// Usage: npx tsx scripts/try-explain.ts [--sha <commit>] [--model <id>] [--repo <path>]
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/index";
import { listCommits } from "../src/server/scope";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const repo = path.resolve(arg("repo", process.cwd()));
const sha = arg("sha", (await listCommits(repo, 2))[1].sha);
const model = arg("model", "claude-sonnet-5-5");

const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-explain-"));
const srv = await startServer({ port: 0, home, log: (m) => console.log("  [server]", m), skillsDir: path.resolve("skills") });
console.log(`server ${srv.url}, home ${home}, commit ${sha.slice(0, 7)}, model ${model}`);
const json = async (p: string, init?: RequestInit) => {
  const r = await fetch(srv.url + p, init);
  return { status: r.status, body: await r.json() };
};
console.log("whiteboard:", (await json("/api/whiteboard/status")).body);

const started = await json("/api/jobs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "review", scope: { type: "commit", repo, sha }, model, whiteboard: "explain" }),
});
console.log("POST /api/jobs →", started.status, started.body.id ?? started.body);
let job = started.body;
const t0 = Date.now();
let last = "";
while (!["done", "failed", "cancelled"].includes(job.status) && Date.now() - t0 < 25 * 60_000) {
  await new Promise((r) => setTimeout(r, 1000));
  job = (await json(`/api/jobs/${job.id}`)).body;
  const line = `${job.status} · ${job.phase ?? ""} · ${job.progress ?? ""}`;
  if (line !== last) {
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${line}`);
    last = line;
  }
}
console.log("job:", { status: job.status, note: job.note, error: job.error, stats: job.stats, elapsed: `${Math.round((Date.now() - t0) / 1000)}s` });
if (job.reviewId) {
  const review = srv.store.get(job.reviewId)!;
  console.log("review:", { findings: review.findings.length, withSteps: review.findings.filter((f) => f.steps?.length).length, whiteboard: review.whiteboard });
}
if (job.status === "failed") console.log("log tail:", job.logTail.slice(-5));
await srv.close();
process.exit(0);
