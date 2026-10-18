// Dev helper: proves the worktree sweep. Uses a scratch REVIEW_APP_HOME and this repo's two latest commits.
// Expected: the unreferenced worktree is removed, the one a review points at and the one a chat scope holds stay,
// and `git worktree list` no longer shows the removed one.
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobManager } from "../src/server/jobs";
import { listCommits, resolveScope, sweepWorktrees } from "../src/server/scope";
import { ReviewStore } from "../src/server/store";

const repo = process.cwd();
const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-sweep-"));
const store = new ReviewStore(path.join(home, "reviews"), console.warn);
await store.load();
const jobs = new JobManager({ store, home, mcpUrl: "http://127.0.0.1:0/mcp", rules: "", log: console.log });
await jobs.load();

const [c1, c2, c3] = await listCommits(repo, 3);
const a = await resolveScope({ type: "commit", repo, sha: c2.sha }, { worktreesDir: jobs.worktreesDir });
const b = await resolveScope({ type: "commit", repo, sha: c3.sha }, { worktreesDir: jobs.worktreesDir });
const c = await resolveScope({ type: "commit", repo, sha: c1.sha }, { worktreesDir: jobs.worktreesDir }); // HEAD → no worktree
console.log("worktrees:", a.isWorktree, b.isWorktree, "| HEAD scope is worktree:", c.isWorktree);

// A review holds `a`; a chat scope holds `b`; nothing holds a stray folder.
await store.create({ repoRoot: a.checkout, scope: { kind: "files", target: a.changedFiles }, summary: "s", findings: [] }, { source: a.source });
const scopeId = jobs.registerScope(b);
const stray = path.join(jobs.worktreesDir, "stray-0000000");
await fs.mkdir(stray, { recursive: true });
await fs.writeFile(path.join(stray, "x.txt"), "x");

// git stores the long path while os.tmpdir() may be the 8.3 short form, so compare by folder name.
const listed = () => execFileSync("git", ["-C", repo, "worktree", "list"]).toString().replace(/\\/g, "/").toLowerCase();
const has = (p: string) => listed().includes(`/${path.basename(p).toLowerCase()} `);
console.log("before: a listed", has(a.checkout), "| b listed", has(b.checkout));

let removed = await jobs.sweepWorktrees();
console.log("sweep #1 removed:", removed.map((p) => path.basename(p)), "(expect only stray)");
console.log("a still listed", has(a.checkout), "| b still listed", has(b.checkout));

// Chat scope consumed (submit happened) and review deleted → both go.
jobs.takeScope(scopeId);
await store.delete(store.list()[0].id);
removed = await jobs.sweepWorktrees();
console.log("sweep #2 removed:", removed.map((p) => path.basename(p)), "(expect a and b)");
console.log("a listed", has(a.checkout), "| b listed", has(b.checkout), "| dir left:", (await fs.readdir(jobs.worktreesDir)).length);

console.log("direct sweep on empty dir:", await sweepWorktrees(path.join(home, "nope"), []));
await fs.rm(home, { recursive: true, force: true });
