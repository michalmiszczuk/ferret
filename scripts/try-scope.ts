// Dev helper: exercises the git scope engine against this repo (creates and removes one worktree).
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parsePrUrl, ownerRepoFromOrigin, originMatches, parseRange, sourceLabel } from "../src/shared/git-parse";
import { resolveScope, removeWorktree, listCommits, defaultBranch } from "../src/server/scope";

const repo = process.cwd();
console.log("parsePrUrl:", parsePrUrl("https://github.com/synergycodes/workflowbuilder/pull/218/files"));
console.log("bitbucket:", parsePrUrl("https://bitbucket.org/team/repo/pull-requests/42/overview"));
console.log("ownerRepo:", ownerRepoFromOrigin("git@github.com:a/b.git"), ownerRepoFromOrigin("https://github.com/a/b"), ownerRepoFromOrigin("ssh://git@bitbucket.org/a/b"));
console.log("originMatches:", originMatches("https://github.com/SynergyCodes/WorkflowBuilder.git", "synergycodes/workflowbuilder"));
console.log("parseRange:", parseRange("HEAD~3..HEAD"), parseRange("a...b"), parseRange("nope"));
console.log("defaultBranch:", await defaultBranch(repo));
console.log("commits:", (await listCommits(repo, 3)).map((c) => `${c.short} ${c.subject}`));

const worktreesDir = path.join(process.env.REVIEW_APP_HOME ?? path.join(os.homedir(), ".review-app"), "worktrees");
const older = (await listCommits(repo, 2))[1].sha;
const s = await resolveScope({ type: "commit", repo, sha: older }, { worktreesDir });
console.log("commit scope:", s.label, "| worktree:", s.isWorktree, "| checkout:", s.checkout, "| files:", s.changedFiles.length, "| diff:", s.diffCommand);
console.log("sourceLabel:", sourceLabel(s.source));
const inList = () => execFileSync("git", ["-C", repo, "worktree", "list"]).toString().replace(/\\/g, "/").includes(s.checkout.replace(/\\/g, "/"));
console.log("git worktree list has it:", inList());
const s2 = await resolveScope({ type: "commit", repo, sha: older }, { worktreesDir });
console.log("reused same path:", s2.checkout === s.checkout);
const c = await resolveScope({ type: "changes", repo }, { worktreesDir });
console.log("changes scope:", c.label, "| worktree:", c.isWorktree, "| files:", c.changedFiles);
const r = await resolveScope({ type: "range", repo, from: "HEAD~2", to: "HEAD" }, { worktreesDir });
console.log("range scope:", r.label, "| worktree:", r.isWorktree, "| files:", r.changedFiles.length);
try { await resolveScope({ type: "commit", repo, sha: "zzzz" }, { worktreesDir }); } catch (e) { console.log("bad sha →", (e as Error).message); }
try { await resolveScope({ type: "changes", repo: os.tmpdir() }, { worktreesDir }); } catch (e) { console.log("non-repo →", (e as Error).message); }
await removeWorktree(repo, s.checkout);
console.log("removed; still listed:", inList());
