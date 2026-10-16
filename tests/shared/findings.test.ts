import { describe, expect, it } from "vitest";
import {
  countBySeverity, filterFindings, listView, navOrder, scopeLabel, sortFindings, toSummary, type Filters,
} from "../../src/shared/findings";
import { SEVERITIES } from "../../src/shared/schema";
import { makeFinding } from "../helpers";

const all: Filters = { severities: [...SEVERITIES], status: "all" };

describe("sortFindings", () => {
  it("orders by severity, then file, then line, without mutating input", () => {
    const input = [
      makeFinding({ id: "a", severity: "low", file: "a.ts", lineStart: 1 }),
      makeFinding({ id: "b", severity: "critical", file: "z.ts", lineStart: 9 }),
      makeFinding({ id: "c", severity: "critical", file: "b.ts", lineStart: 5 }),
      makeFinding({ id: "d", severity: "critical", file: "b.ts", lineStart: 2 }),
      makeFinding({ id: "e", severity: "high", file: "a.ts", lineStart: 1 }),
    ];
    expect(sortFindings(input).map((f) => f.id)).toEqual(["d", "c", "b", "e", "a"]);
    expect(input[0].id).toBe("a");
  });
});

describe("filterFindings", () => {
  const fs = [
    makeFinding({ id: "open", severity: "high", status: "open" }),
    makeFinding({ id: "req", severity: "low", status: "fix_requested" }),
    makeFinding({ id: "fixing", severity: "high", status: "fixing" }),
    makeFinding({ id: "fixed", severity: "high", status: "fixed" }),
    makeFinding({ id: "dis", severity: "medium", status: "dismissed" }),
    makeFinding({ id: "skip", severity: "medium", status: "skipped" }),
  ];

  it("open = not done (open, fix_requested, fixing)", () => {
    expect(filterFindings(fs, { ...all, status: "open" }).map((f) => f.id)).toEqual(["open", "req", "fixing"]);
  });

  it("done = fixed, dismissed, skipped", () => {
    expect(filterFindings(fs, { ...all, status: "done" }).map((f) => f.id)).toEqual(["fixed", "dis", "skip"]);
  });

  it("filters by severity", () => {
    expect(filterFindings(fs, { severities: ["low"], status: "all" }).map((f) => f.id)).toEqual(["req"]);
  });
});

describe("listView / navOrder", () => {
  const fs = [
    makeFinding({ id: "low", severity: "low" }),
    makeFinding({ id: "crit", severity: "critical" }),
    makeFinding({ id: "done", severity: "critical", status: "fixed" }),
  ];

  it("splits active and done, each sorted", () => {
    const v = listView(fs, all);
    expect(v.active.map((f) => f.id)).toEqual(["crit", "low"]);
    expect(v.done.map((f) => f.id)).toEqual(["done"]);
  });

  it("navOrder skips collapsed done group", () => {
    expect(navOrder(fs, all, false).map((f) => f.id)).toEqual(["crit", "low"]);
    expect(navOrder(fs, all, true).map((f) => f.id)).toEqual(["crit", "low", "done"]);
  });

  it("navOrder includes done when the status filter is done, even if collapsed", () => {
    expect(navOrder(fs, { ...all, status: "done" }, false).map((f) => f.id)).toEqual(["done"]);
  });
});

describe("countBySeverity / scopeLabel / toSummary", () => {
  it("counts every severity, including zeros", () => {
    expect(countBySeverity([makeFinding({ severity: "high" }), makeFinding({ severity: "high" })])).toEqual({
      critical: 0, high: 2, medium: 0, low: 0,
    });
  });

  it("labels scopes", () => {
    expect(scopeLabel({ kind: "diff", target: "uncommitted" })).toBe("uncommitted changes");
    expect(scopeLabel({ kind: "files", target: ["src/a.ts", "lib/"] })).toBe("src/a.ts, lib/");
  });

  it("summarizes a review", () => {
    const s = toSummary({
      id: "r_1", createdAt: "2026-10-15T10:00:00.000Z", repoRoot: "C:\\code\\my-repo",
      scope: { kind: "diff", target: "uncommitted" }, summary: "x", agent: "claude",
      findings: [makeFinding({ severity: "critical", status: "fix_requested" }), makeFinding({ severity: "low" })],
    });
    expect(s).toEqual({
      id: "r_1", createdAt: "2026-10-15T10:00:00.000Z", repoName: "my-repo",
      scope: { kind: "diff", target: "uncommitted" },
      counts: { critical: 1, high: 0, medium: 0, low: 1 }, pending: 1, total: 2,
    });
  });
});
