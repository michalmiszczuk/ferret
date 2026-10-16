import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreEvent } from "../../src/shared/api-types";
import { NotFoundError, ReviewStore } from "../../src/server/store";
import { makeReviewInput, tmpDir } from "../helpers";

async function newStore() {
  const dir = await tmpDir("review-app-store-");
  const store = new ReviewStore(dir, () => {});
  await store.load();
  return { dir, store };
}

afterEach(() => vi.useRealTimers());

describe("ReviewStore.create", () => {
  it("assigns ids, defaults, normalizes paths and persists to disk", async () => {
    const { dir, store } = await newStore();
    const input = makeReviewInput("C:\\repo");
    input.findings[0].file = "src\\a.ts";
    const review = await store.create(input);

    expect(review.id).toMatch(/^r_[0-9a-f]{6}$/);
    expect(review.agent).toBe("claude");
    expect(review.findings.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(review.findings[0]).toMatchObject({ file: "src/a.ts", status: "open", originalSeverity: "low" });

    const reloaded = new ReviewStore(dir, () => {});
    await reloaded.load();
    expect(reloaded.get(review.id)).toEqual(review);
  });

  it("emits review-created", async () => {
    const { store } = await newStore();
    const events: StoreEvent[] = [];
    store.on("change", (e: StoreEvent) => events.push(e));
    const review = await store.create(makeReviewInput("/repo"));
    expect(events).toEqual([{ type: "review-created", reviewId: review.id }]);
  });

  it("rejects a finding outside the repo and stores nothing", async () => {
    const { dir, store } = await newStore();
    const input = makeReviewInput("C:\\repo");
    input.findings[0].file = "C:\\elsewhere\\x.ts";
    await expect(store.create(input)).rejects.toThrow(/outside repoRoot/);
    expect(store.list()).toEqual([]);
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".json"))).toEqual([]);
  });
});

describe("ReviewStore.list / latest", () => {
  it("returns newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store } = await newStore();
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    const older = await store.create(makeReviewInput("/repo"));
    vi.setSystemTime(new Date("2026-10-15T11:00:00Z"));
    const newer = await store.create(makeReviewInput("/repo"));
    expect(store.list().map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(store.latest()?.id).toBe(newer.id);
  });
});

describe("ReviewStore.updateFinding", () => {
  it("patches, persists and emits review-updated", async () => {
    const { dir, store } = await newStore();
    const review = await store.create(makeReviewInput("/repo"));
    const events: StoreEvent[] = [];
    store.on("change", (e: StoreEvent) => events.push(e));

    const f = await store.updateFinding(review.id, "f2", { status: "fix_requested", myNote: "keep API" });
    expect(f).toMatchObject({ status: "fix_requested", myNote: "keep API" });
    expect(events).toEqual([{ type: "review-updated", reviewId: review.id }]);

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, `${review.id}.json`), "utf8"));
    expect(onDisk.findings[1].status).toBe("fix_requested");
  });

  it("throws NotFoundError for unknown review or finding", async () => {
    const { store } = await newStore();
    const review = await store.create(makeReviewInput("/repo"));
    await expect(store.updateFinding("r_nope", "f1", {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.updateFinding(review.id, "f9", {})).rejects.toThrow("Finding f9 not found");
  });
});

describe("ReviewStore.takePending", () => {
  it("moves fix_requested to fixing, sorted by severity; a second call returns nothing", async () => {
    const { store } = await newStore();
    const review = await store.create(makeReviewInput("/repo"));
    await store.updateFinding(review.id, "f1", { status: "fix_requested" }); // low
    await store.updateFinding(review.id, "f2", { status: "fix_requested" }); // critical

    const first = await store.takePending(review.id);
    expect(first.findings.map((f) => f.id)).toEqual(["f2", "f1"]);
    expect(store.get(review.id)!.findings.every((f) => f.status === "fixing")).toBe(true);
    expect(store.countFixing(review.id)).toBe(2);

    const second = await store.takePending(review.id);
    expect(second.findings).toEqual([]);
  });

  it("uses the latest review when no id is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store } = await newStore();
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    await store.create(makeReviewInput("/repo"));
    vi.setSystemTime(new Date("2026-10-15T11:00:00Z"));
    const newer = await store.create(makeReviewInput("/repo"));
    expect((await store.takePending()).review.id).toBe(newer.id);
  });

  it("explains when there are no reviews", async () => {
    const { store } = await newStore();
    await expect(store.takePending()).rejects.toThrow(/No reviews yet/);
  });
});

describe("ReviewStore.load", () => {
  it("skips corrupt files and logs a warning", async () => {
    const dir = await tmpDir("review-app-store-");
    await fs.writeFile(path.join(dir, "r_bad000.json"), "{ not json");
    const logs: string[] = [];
    const store = new ReviewStore(dir, (m) => logs.push(m));
    await store.load();
    expect(store.list()).toEqual([]);
    expect(logs.join("\n")).toContain("r_bad000.json");
  });
});
