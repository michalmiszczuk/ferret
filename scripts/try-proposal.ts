// Dev helper: proves the ProposalStore on a scratch repo folder. Every check prints `ok: …`; a failed check throws.
// Run: npx tsx scripts/try-proposal.ts
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { REFRESH_TEXT } from "../src/server/api";
import { listLiveSessions } from "../src/server/claude-sessions";
import { startServer } from "../src/server/index";
import { mountMcp } from "../src/server/mcp";
import { ProposalStore } from "../src/server/proposal-store";
import { ReviewStore } from "../src/server/store";

const ok = (what: string) => console.log(`ok: ${what}`);
const repo = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-proposal-"));
await fs.mkdir(path.join(repo, "src"), { recursive: true });
const aFile = path.join(repo, "src", "a.ts");
await fs.writeFile(aFile, "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
const readFile = async (rel: string) => {
  try {
    return await fs.readFile(path.join(repo, rel), "utf8");
  } catch {
    return null;
  }
};

const store = new ProposalStore(path.join(repo, ".proposals"), console.warn);
await store.load();
const events: string[] = [];
store.on("change", (e: { type: string }) => events.push(e.type));

const base = { repoRoot: repo, task: { title: "Rename b" } };
const s1 = { stepId: "s1", title: "Rename b", kind: "edit" as const, file: "src/a.ts", lineStart: 2, lineEnd: 2, what: "w", why: "y", before: "export const b = 2;", after: "export const bee = 2;" };
const s2 = { stepId: "s2", title: "Use bee", kind: "edit" as const, file: "src/a.ts", lineStart: 3, lineEnd: 3, what: "w", why: "y", before: "export const c = 3;", after: "export const c = bee + 1;", dependsOn: ["s1"] };
const s3 = { stepId: "s3", title: "Typecheck", kind: "command" as const, what: "w", why: "y", command: "npm run typecheck" };

// Part 1: store
const p = await store.create({ ...base, steps: [s1, s2, s3] });
assert.match(p.id, /^p_[0-9a-f]{6}$/);
assert.equal(p.status, "active");
assert.deepEqual(events, ["proposal-created"]);
ok(`create → ${p.id}, 3 pending steps, proposal-created emitted`);

let views = await store.views(p, readFile);
assert.equal(views[0].stale, false);
assert.equal(views[0].blocked, false);
assert.equal(views[1].blocked, true);
assert.deepEqual(views[1].blockedBy, ["s1"]);
assert.equal(views[2].blocked, false);
ok("views: s1 not stale, s2 blocked by s1, s3 free");

await assert.rejects(store.decide(p.id, "s2", { kind: "accept" }), /waits for s1/);
ok("accept on a blocked step is rejected");

const accepted = await store.decide(p.id, "s1", { kind: "accept" });
assert.equal(accepted.status, "accepted");
assert.equal(accepted.decision?.taken, false);
let taken = await store.takeDecisions(p.id);
assert.deepEqual(taken.steps.map((s) => s.stepId), ["s1"]);
assert.equal(taken.steps[0].decision?.taken, true);
taken = await store.takeDecisions(p.id);
assert.equal(taken.steps.length, 0);
ok("decide(s1, accept) → takeDecisions returns s1 once, then nothing");

await store.markStep(p.id, "s1", "applied", "renamed");
assert.equal(store.get(p.id)!.steps[0].status, "applied");
assert.equal(store.get(p.id)!.steps[0].thread.at(-1)?.kind, "note");
views = await store.views(store.get(p.id)!, readFile);
assert.equal(views[1].blocked, false);
ok("markStep(s1, applied) → note in thread, s2 unblocked");

await assert.rejects(store.decide(p.id, "s1", { kind: "decline" }), /already applied/);
ok("decide on an applied step is rejected");

const declined = await store.decide(p.id, "s2", { kind: "decline", text: "not needed" });
assert.equal(declined.status, "declined");
assert.equal(declined.thread.at(-1)?.text, "not needed");
assert.equal(store.get(p.id)!.status, "active");
await store.markStep(p.id, "s3", "skipped");
assert.equal(store.get(p.id)!.status, "done");
ok("decline s2, skip s3 → proposal done");

// ask → answer → pending again
const p2 = await store.create({ ...base, steps: [s1] });
await store.decide(p2.id, "s1", { kind: "ask", text: "why bee?" });
assert.equal(store.get(p2.id)!.steps[0].status, "asked");
await store.answer(p2.id, "s1", "because");
assert.equal(store.get(p2.id)!.steps[0].status, "pending");
assert.equal(store.get(p2.id)!.steps[0].decision, undefined);
assert.deepEqual(store.get(p2.id)!.steps[0].thread.map((t) => `${t.by}:${t.kind}`), ["you:ask", "claude:answer"]);
ok("ask → answer → pending, thread you:ask / claude:answer");

await store.reviseStep(p2.id, "s1", { after: "export const bee = 22;" });
const revised = store.get(p2.id)!.steps[0];
assert.equal(revised.revisions.length, 1);
assert.equal(revised.revisions[0].after, "export const bee = 2;");
assert.equal(revised.after, "export const bee = 22;");
ok("reviseStep keeps the previous text in revisions");

const all = await store.acceptAllRemaining(p2.id);
assert.deepEqual(all.map((s) => s.stepId), ["s1"]);
ok("acceptAllRemaining accepts the pending unblocked step");

await store.addSteps(p2.id, [s3], "s1");
assert.deepEqual(store.get(p2.id)!.steps.map((s) => s.stepId), ["s1", "s3"]);
ok("addSteps after s1");

// stale after the file changes
await fs.writeFile(aFile, "export const a = 1;\nexport const c = 3;\n");
const p3 = await store.create({ ...base, steps: [s1] });
views = await store.views(p3, readFile);
assert.equal(views[0].stale, true);
const p4 = await store.create({ ...base, steps: [{ ...s1, file: "src/missing.ts" }] });
assert.equal((await store.views(p4, readFile))[0].stale, true);
ok("edit step on changed / missing file is stale");

// batch approvals: s2 depends on s1, both in the batch → both accepted in order; a stale one and an applied one skipped
const pb = await store.create({ ...base, steps: [{ ...s1, before: "export const a = 1;", lineStart: 1, lineEnd: 1 }, { ...s2, before: "export const c = 3;", lineStart: 2, lineEnd: 2 }, s3] });
await store.decide(pb.id, "s3", { kind: "accept" });
await store.markStep(pb.id, "s3", "applied");
const batch = await store.acceptSteps(pb.id, ["s2", "s1", "s3"]);
assert.deepEqual(batch.accepted.map((s) => s.stepId), ["s1", "s2"]);
assert.deepEqual(batch.skipped, [{ stepId: "s3", reason: "already applied" }]);
const pb2 = await store.create({ ...base, steps: [s1, s2] });
const b2 = await store.acceptSteps(pb2.id, ["s2"], new Set());
assert.deepEqual(b2.skipped, [{ stepId: "s2", reason: "waits for s1" }]);
const b3 = await store.acceptSteps(pb2.id, ["s1"], new Set(["s1"]));
assert.deepEqual(b3.skipped, [{ stepId: "s1", reason: "stale (the file changed)" }]);
await store.delete(pb.id);
await store.delete(pb2.id);
ok("acceptSteps: dependency inside the batch accepted in order; applied / waiting / stale skipped with reasons");

// validation
await assert.rejects(store.create({ ...base, steps: [s1, { ...s3, stepId: "s1" }] }), /step s1: stepId is used twice/);
await assert.rejects(store.create({ ...base, steps: [{ ...s2, dependsOn: ["nope"] }] }), /step s2: dependsOn nope is not a step of this proposal/);
ok("duplicate stepId and unknown dependsOn are rejected");
await assert.rejects(store.create({ ...base, steps: [{ ...s1, dependsOn: ["s1"] }] }), /step s1: dependsOn must not name the step itself/);
await assert.rejects(store.create({ ...base, steps: [{ ...s1, dependsOn: ["s2"] }, { ...s2, dependsOn: ["s1"] }] }), /step s1: dependsOn forms a cycle/);
const abs = await store.create({ ...base, steps: [{ ...s1, file: path.join(repo, "src", "a.ts") }, { ...s3, file: undefined }] });
assert.equal(abs.steps[0].file, "src/a.ts");
await assert.rejects(store.create({ ...base, steps: [{ ...s1, file: "../outside.ts" }] }), /step s1: file "\.\.\/outside\.ts" must not contain/);
await store.delete(abs.id);
ok("self and cyclic dependsOn rejected; absolute file normalised to repo-relative; .. rejected");

// persistence
const again = new ProposalStore(path.join(repo, ".proposals"), console.warn);
await again.load();
assert.equal(again.list().length, 4);
assert.equal(again.get(p.id)!.status, "done");
await again.delete(p4.id);
assert.equal(again.list().length, 3);
ok("reload sees 4 proposals, delete removes one");

// Part 2: MCP tools over /mcp
await fs.writeFile(aFile, "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
const reviews = new ReviewStore(path.join(repo, ".reviews"), console.warn);
await reviews.load();
const app = express();
const listener = app.listen(0, "127.0.0.1");
await new Promise((res) => listener.once("listening", res));
const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
mountMcp(app, reviews, () => url, { proposals: again });
const client = new Client({ name: "chat", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
type ToolResult = { content: { text: string }[]; isError?: boolean };
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<ToolResult>;
const data = (r: ToolResult) => {
  assert.equal(r.isError ?? false, false, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const errorOf = async (name: string, args: Record<string, unknown>) => {
  try {
    const r = await call(name, args);
    assert.equal(r.isError, true, "expected an error");
    return r.content[0].text;
  } catch (err) {
    return (err as Error).message;
  }
};

const { tools } = await client.listTools();
assert.equal(tools.filter((t) => ["propose_changes", "add_steps", "revise_step", "answer_proposal", "get_proposal_decisions", "mark_step"].includes(t.name)).length, 6);
ok("six proposal tools listed");

const proposed = data(await call("propose_changes", { ...base, sessionId: "sess-1", steps: [s1, s2, s3] }));
assert.match(proposed.proposalId, /^p_/);
assert.equal(proposed.url, `${url}/p/${proposed.proposalId}`);
assert.equal(proposed.steps, 3);
const pid = proposed.proposalId as string;
assert.equal(again.get(pid)!.sessionId, "sess-1");
ok(`propose_changes → ${pid} with url and step count`);

let got = data(await call("get_proposal_decisions", { proposalId: pid }));
assert.deepEqual(got.decisions, []);
assert.match(got.message, /No new decisions/);
ok("get_proposal_decisions: empty with a message");

await again.decide(pid, "s1", { kind: "accept" });
got = data(await call("get_proposal_decisions", {}));
assert.equal(got.proposalId, pid);
assert.equal(got.repoRoot, repo);
assert.equal(got.decisions.length, 1);
assert.deepEqual({ stepId: got.decisions[0].stepId, decision: got.decisions[0].decision, stale: got.decisions[0].stale, before: got.decisions[0].before }, { stepId: "s1", decision: "accept", stale: false, before: s1.before });
got = data(await call("get_proposal_decisions", { proposalId: pid }));
assert.equal(got.decisions.length, 0);
ok("decide → get_proposal_decisions returns s1 (stale:false) once");

const marked = data(await call("mark_step", { proposalId: pid, stepId: "s1", outcome: "applied", note: "renamed b" }));
assert.deepEqual(marked, { ok: true, remaining: 0, proposalStatus: "active" });
assert.equal(again.get(pid)!.steps[0].status, "applied");
ok("mark_step applied");

await again.decide(pid, "s2", { kind: "ask", text: "why?" });
data(await call("answer_proposal", { proposalId: pid, stepId: "s2", answer: "because" }));
assert.equal(again.get(pid)!.steps[1].status, "pending");
ok("answer_proposal: asked → pending");

const rev = data(await call("revise_step", { proposalId: pid, stepId: "s2", after: "export const c = bee + 2;" }));
assert.equal(rev.revisions, 1);
assert.equal(again.get(pid)!.steps[1].after, "export const c = bee + 2;");
ok("revise_step keeps a revision");

const added = data(await call("add_steps", { proposalId: pid, steps: [{ ...s3, stepId: "s4" }] }));
assert.deepEqual(added.steps.map((s: { stepId: string }) => s.stepId), ["s1", "s2", "s3", "s4"]);
ok("add_steps appends s4");

await again.acceptSteps(pid, ["s2", "s3", "s4"]);
const batchMarked = data(await call("mark_steps", { proposalId: pid, steps: [
  { stepId: "s2", outcome: "applied", note: "edited" },
  { stepId: "s3", outcome: "applied", note: "0 errors" },
  { stepId: "s4", outcome: "skipped" },
] }));
assert.deepEqual(batchMarked, { ok: true, marked: 3, remaining: 0, proposalStatus: "done" });
assert.match(await errorOf("mark_steps", { proposalId: pid, steps: [{ stepId: "nope", outcome: "applied" }] }), /Step nope not found/);
ok("mark_steps reports three steps in one call (proposal done); an unknown step fails the call");

const many = Array.from({ length: 51 }, (_, i) => ({ ...s3, stepId: `c${i}` }));
assert.match(await errorOf("propose_changes", { ...base, steps: many }), /steps/);
assert.match(await errorOf("propose_changes", { ...base, steps: [{ ...s1, before: "x".repeat(25_000) }] }), /before/);
assert.match(await errorOf("propose_changes", { ...base, steps: [{ ...s1, before: undefined }] }), /before/);
ok("51 steps, a 25 KB before and a missing before are rejected naming the field");

await client.close();
listener.close();

// Part 3: HTTP API + delivery through the full server (courier replaced by a spy)
const sent: { agent: string; text: string }[] = [];
const home = path.join(repo, ".home");
const srv = await startServer({ port: 0, home, log: () => {}, claudePath: path.resolve("tests/fake-claude/claude.cjs"), deliver: async (agent, text) => void sent.push({ agent, text }) });
const live = await listLiveSessions();
const sessionId = live[0]?.sessionId ?? "not-running";
console.log(`live Claude sessions: ${live.length}${live[0] ? ` (using ${live[0].name})` : " → expect delivered:false"}`);
const post = async (p: string, body?: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) => {
  const res = await fetch(`${srv.url}/api${p}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const sseEvents: string[] = [];
const sse = new AbortController();
void fetch(`${srv.url}/api/events`, { signal: sse.signal }).then(async (res) => {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split("\n")) if (line.startsWith("data: ")) sseEvents.push(JSON.parse(line.slice(6)).type);
  }
}).catch(() => {});

const p5 = await srv.proposals.create({ ...base, sessionId, steps: [s1, s2, s3] });
let list = (await (await fetch(`${srv.url}/api/proposals`)).json()) as { id: string; title: string; progress: { applied: number; total: number } }[];
assert.deepEqual(list.map((x) => [x.id, x.title, x.progress.total]), [[p5.id, "Rename b", 3]]);
const full = (await (await fetch(`${srv.url}/api/proposals/${p5.id}`)).json()) as { steps: { stepId: string; blocked: boolean; stale: boolean }[] };
assert.deepEqual(full.steps.map((s) => [s.stepId, s.blocked, s.stale]), [["s1", false, false], ["s2", true, false], ["s3", false, false]]);
ok("GET /proposals and /proposals/:id with step views");

assert.equal((await post(`/proposals/${p5.id}/steps/s1/decide`, "x", { "Content-Type": "text/plain" })).status, 415);
assert.equal((await post(`/proposals/${p5.id}/steps/s1/decide`, { kind: "maybe" })).status, 400);
assert.equal((await post(`/proposals/${p5.id}/steps/s2/decide`, { kind: "accept" })).status, 400);
assert.equal((await post(`/proposals/nope/steps/s2/decide`, { kind: "accept" })).status, 404);
ok("415 on non-JSON, 400 on bad kind / blocked step, 404 on unknown proposal");

let r = await post(`/proposals/${p5.id}/steps/s1/decide`, { kind: "ask", text: "why\nbee?" });
assert.equal(r.status, 200);
assert.equal(r.body.step.status, "asked");
const expectDelivered = live.length > 0;
assert.equal(r.body.delivered, expectDelivered, JSON.stringify(r.body));
if (expectDelivered) {
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agent, live[0].name);
  assert.equal(sent[0].text, `Ferret: a decision on your proposal. Please handle it now: /apply-proposal ${p5.id} s1 ask why bee?`);
} else {
  assert.match(r.body.reason, /isn't running/);
}
ok(`decide ask → ${expectDelivered ? "delivered via the courier with the one-line command" : "delivered:false with a reason"}`);

await srv.proposals.answer(p5.id, "s1", "because");
r = await post(`/proposals/${p5.id}/steps/s1/refresh`, {});
assert.equal(r.body.step.thread.at(-1).text, REFRESH_TEXT);
await srv.proposals.answer(p5.id, "s1", "revised");
ok("refresh sends the canned ask");

sent.length = 0;
r = await post(`/proposals/${p5.id}/accept-all`, {});
assert.deepEqual(r.body.steps.map((s: { stepId: string }) => s.stepId), ["s1", "s3"]);
assert.equal(sent.length, expectDelivered ? 1 : 0);
if (expectDelivered) assert.match(sent[0].text, new RegExp(`/apply-proposal ${p5.id} accept-all$`));
r = await post(`/proposals/${p5.id}/accept-all`, {});
assert.deepEqual(r.body, { steps: [], delivered: false, reason: "Nothing left to accept" });
ok("accept-all: one courier call for s1+s3 (s2 blocked), nothing the second time");

await new Promise((res) => setTimeout(res, 100));
assert.ok(sseEvents.includes("proposal-created") && sseEvents.includes("proposal-updated"), sseEvents.join(","));
const del = await fetch(`${srv.url}/api/proposals/${p5.id}`, { method: "DELETE" });
assert.equal(del.status, 200);
assert.equal((await (await fetch(`${srv.url}/api/proposals`)).json() as unknown[]).length, 0);
ok("SSE relayed proposal-created/updated; DELETE removes the proposal");

sse.abort();
await srv.close();
await fs.rm(repo, { recursive: true, force: true });
console.log("done");
process.exit(0);
