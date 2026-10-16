import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../../src/server/index";
import { makeRepo, makeReviewInput, startTestServer } from "../helpers";

let srv: RunningServer & { home: string };
let client: Client;
let repo: string;

beforeEach(async () => {
  repo = await makeRepo({ "src/a.ts": "line1\nconst x = 1;\nline3\n" });
  srv = await startTestServer();
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
});
afterEach(async () => {
  await client.close();
  await srv.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = (r: any) => JSON.parse(r.content[0].text);
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

/** The SDK may surface validation failures as a thrown error or as an isError result; accept both. */
async function errorText(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const r = await call(name, args);
    expect(r.isError).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (r as any).content[0].text as string;
  } catch (err) {
    return (err as Error).message;
  }
}

const markFix = (reviewId: string, fid: string, myNote?: string) =>
  fetch(`${srv.url}/api/reviews/${reviewId}/findings/${fid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "fix_requested", ...(myNote ? { myNote } : {}) }),
  });

describe("MCP tools", () => {
  it("lists the three tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_pending_actions", "mark_done", "submit_review"]);
  });

  it("submit_review stores the review and returns id, url and counts", async () => {
    const out = data(await call("submit_review", makeReviewInput(repo)));
    expect(out.reviewId).toMatch(/^r_/);
    expect(out.url).toBe(`${srv.url}/r/${out.reviewId}`);
    expect(out.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 1 });
    expect(srv.store.get(out.reviewId)).toBeDefined();
  });

  it("submit_review rejects invalid findings with a useful message", async () => {
    const input = makeReviewInput(repo);
    input.findings[0].lineEnd = 0;
    expect(await errorText("submit_review", input)).toMatch(/lineEnd/);
  });

  it("submit_review rejects files outside the repo", async () => {
    const input = makeReviewInput(repo);
    input.findings[0].file = "C:\\totally\\elsewhere.ts";
    expect(await errorText("submit_review", input)).toMatch(/outside repoRoot/);
  });

  it("submit_review rejects a repoRoot that is not an existing directory", async () => {
    const input = makeReviewInput(path.join(repo, "does-not-exist"));
    expect(await errorText("submit_review", input)).toMatch(/not an existing directory/);
    expect(srv.store.list()).toEqual([]);
  });

  it.runIf(process.platform === "win32")("submit_review accepts a Git Bash style root (/c/...) and stores a Windows path", async () => {
    const gitBash = repo.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
    const out = data(await call("submit_review", makeReviewInput(gitBash)));
    const stored = srv.store.get(out.reviewId)!;
    expect(stored.repoRoot.toLowerCase()).toBe(repo.toLowerCase());
    const file = await (await fetch(`${srv.url}/api/reviews/${out.reviewId}/file?path=src/a.ts`)).json();
    expect(file.exists).toBe(true);
  });

  it("full loop: pending (with note, re-anchored) → fixing → mark_done → fixed; second pull is empty", async () => {
    const { reviewId } = data(await call("submit_review", makeReviewInput(repo)));
    await markFix(reviewId, "f2", "keep the API");
    // Code changed after the review: two lines inserted on top.
    await fs.writeFile(path.join(repo, "src/a.ts"), "// a\n// b\nline1\nconst x = 1;\nline3\n");

    const pending = data(await call("get_pending_actions", { reviewId }));
    expect(pending.repoRoot).toBe(repo);
    expect(pending.actions).toHaveLength(1);
    expect(pending.actions[0]).toMatchObject({
      findingId: "f2", myNote: "keep the API", file: "src/a.ts", lineStart: 4, lineEnd: 4, anchor: "moved",
    });
    expect(srv.store.get(reviewId)!.findings[1].status).toBe("fixing");

    const again = data(await call("get_pending_actions", { reviewId }));
    expect(again.actions).toEqual([]);
    expect(again.message).toMatch(/Nothing pending/);

    const done = data(await call("mark_done", { reviewId, findingId: "f2", outcome: "fixed", note: "Added null check" }));
    expect(done).toEqual({ ok: true, remaining: 0 });
    expect(srv.store.get(reviewId)!.findings[1]).toMatchObject({ status: "fixed", resolution: "Added null check" });
  });

  it("get_pending_actions without id uses the latest review", async () => {
    const { reviewId } = data(await call("submit_review", makeReviewInput(repo)));
    await markFix(reviewId, "f1");
    const pending = data(await call("get_pending_actions", {}));
    expect(pending.reviewId).toBe(reviewId);
    expect(pending.actions.map((a: { findingId: string }) => a.findingId)).toEqual(["f1"]);
  });

  it("errors clearly when there are no reviews or ids are wrong", async () => {
    expect(await errorText("get_pending_actions", {})).toMatch(/No reviews yet/);
    expect(await errorText("mark_done", { reviewId: "r_x", findingId: "f1", outcome: "fixed", note: "n" })).toMatch(/not found/);
  });

  it("GET /mcp is 405", async () => {
    expect((await fetch(`${srv.url}/mcp`)).status).toBe(405);
  });
});
