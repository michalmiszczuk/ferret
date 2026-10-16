import { describe, expect, it } from "vitest";
import { findingPatchSchema, submitReviewSchema } from "../../src/shared/schema";

const valid = {
  repoRoot: "C:/repo",
  scope: { kind: "diff", target: "uncommitted" },
  summary: "Looks mostly fine",
  findings: [
    {
      severity: "critical",
      title: "Token never expires",
      body: "Expired sessions are accepted.",
      category: "security",
      file: "src/auth.ts",
      lineStart: 10,
      lineEnd: 12,
      snippet: "return s.user",
    },
  ],
};

describe("submitReviewSchema", () => {
  it("accepts a valid review", () => {
    expect(submitReviewSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a files scope", () => {
    const r = submitReviewSchema.safeParse({ ...valid, scope: { kind: "files", target: ["src/auth/"] } });
    expect(r.success).toBe(true);
  });

  it("rejects lineEnd < lineStart with a message naming lineEnd", () => {
    const bad = { ...valid, findings: [{ ...valid.findings[0], lineStart: 12, lineEnd: 10 }] };
    const r = submitReviewSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("lineEnd");
  });

  it("rejects unknown severity", () => {
    const bad = { ...valid, findings: [{ ...valid.findings[0], severity: "blocker" }] };
    expect(submitReviewSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects line numbers below 1", () => {
    const bad = { ...valid, findings: [{ ...valid.findings[0], lineStart: 0 }] };
    expect(submitReviewSchema.safeParse(bad).success).toBe(false);
  });
});

describe("findingPatchSchema", () => {
  it("allows the user-settable statuses, severity and note", () => {
    expect(findingPatchSchema.safeParse({ status: "fix_requested", myNote: "keep API" }).success).toBe(true);
    expect(findingPatchSchema.safeParse({ status: "dismissed" }).success).toBe(true);
    expect(findingPatchSchema.safeParse({ severity: "low" }).success).toBe(true);
  });

  it("rejects statuses only Claude may set", () => {
    expect(findingPatchSchema.safeParse({ status: "fixed" }).success).toBe(false);
    expect(findingPatchSchema.safeParse({ status: "fixing" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(findingPatchSchema.safeParse({ resolution: "hack" }).success).toBe(false);
  });
});
