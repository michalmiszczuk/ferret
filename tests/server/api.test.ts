import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../../src/server/index";
import { makeRepo, makeReviewInput, startTestServer } from "../helpers";

let srv: RunningServer & { home: string };
let repo: string;

beforeEach(async () => {
  repo = await makeRepo({ "src/a.ts": "line1\nconst x = 1;\nline3\n" });
  srv = await startTestServer();
});
afterEach(async () => {
  await srv.close();
});

const get = (p: string) => fetch(srv.url + p);
const patch = (p: string, body: unknown) =>
  fetch(srv.url + p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("REST API", () => {
  it("lists review summaries newest first", async () => {
    expect(await (await get("/api/reviews")).json()).toEqual([]);
    const review = await srv.store.create(makeReviewInput(repo));
    const list = await (await get("/api/reviews")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: review.id, total: 2, pending: 0, counts: { critical: 1, low: 1 } });
  });

  it("returns a review or 404", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    expect((await (await get(`/api/reviews/${review.id}`)).json()).id).toBe(review.id);
    expect((await get("/api/reviews/r_nope")).status).toBe(404);
  });

  it("patches user-settable fields and rejects Claude-only statuses", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    const ok = await patch(`/api/reviews/${review.id}/findings/f2`, { status: "fix_requested", myNote: "keep API" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "fix_requested", myNote: "keep API" });

    expect((await patch(`/api/reviews/${review.id}/findings/f2`, { status: "fixed" })).status).toBe(400);
    expect((await patch(`/api/reviews/${review.id}/findings/f9`, { status: "open" })).status).toBe(404);
  });

  it("serves file content with anchors for that file's findings", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    const body = await (await get(`/api/reviews/${review.id}/file?path=src/a.ts`)).json();
    expect(body.exists).toBe(true);
    expect(body.content).toContain("const x = 1;");
    expect(body.changedLines).toEqual([]);
    expect(body.anchors.f2).toEqual({ lineStart: 2, lineEnd: 2, anchor: "exact" });
  });

  it("reports missing files and rejects escaping paths", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    expect(await (await get(`/api/reviews/${review.id}/file?path=gone.ts`)).json()).toEqual({ exists: false });
    expect((await get(`/api/reviews/${review.id}/file?path=../x`)).status).toBe(400);
    expect((await get(`/api/reviews/${review.id}/file`)).status).toBe(400);
  });

  it("answers 400 with a clear message when the review's repo folder is gone", async () => {
    const review = await srv.store.create(makeReviewInput(repo + "-deleted"));
    const res = await get(`/api/reviews/${review.id}/file?path=src/a.ts`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/repoRoot not found/);
  });
});

describe("SSE /api/events", () => {
  it("pushes review-updated when a finding changes", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(srv.url + "/api/events", { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = dec.decode((await reader.read()).value); // ": connected"

    await srv.store.updateFinding(review.id, "f1", { status: "dismissed" });
    while (!buf.includes("review-updated")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    clearTimeout(timer);
    ac.abort();
    expect(buf).toContain(`"reviewId":"${review.id}"`);
  });
});

describe("host guard", () => {
  it("rejects requests whose Host header is not localhost", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: srv.port, path: "/api/reviews", headers: { Host: `evil.example:${srv.port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("accepts localhost:<port>", async () => {
    const res = await fetch(`http://localhost:${srv.port}/api/reviews`).catch(() => null);
    // On some machines "localhost" resolves to ::1 only, where nothing listens. That is fine; we only assert no 403.
    if (res) expect(res.status).toBe(200);
  });
});
