import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  anchorFinding, changedLines, parseDiffNewLines, PathError, readRepoFile, reanchor, resolveInRepo,
} from "../../src/server/files";
import { makeRepo, tmpDir } from "../helpers";

describe("resolveInRepo / readRepoFile", () => {
  it("reads a file in a directory with non-ASCII characters and spaces", async () => {
    const parent = await tmpDir("review-app-");
    const repo = await makeRepo({ "src/a.ts": "hello" }, path.join(parent, "Michał repo"));
    expect(await readRepoFile(repo, "src/a.ts")).toEqual({ exists: true, content: "hello" });
  });

  it("reports missing files without throwing", async () => {
    const repo = await makeRepo({});
    expect(await readRepoFile(repo, "nope.ts")).toEqual({ exists: false });
  });

  it("rejects .. and absolute paths", async () => {
    const repo = await makeRepo({ "a.ts": "x" });
    await expect(resolveInRepo(repo, "../secret.txt")).rejects.toBeInstanceOf(PathError);
    await expect(resolveInRepo(repo, path.join(repo, "a.ts"))).rejects.toBeInstanceOf(PathError);
  });

  it("rejects a link that escapes the repo", async () => {
    const outside = await makeRepo({ "secret.txt": "top secret" });
    const repo = await makeRepo({ "a.ts": "x" });
    await fs.symlink(outside, path.join(repo, "out"), "junction");
    await expect(readRepoFile(repo, "out/secret.txt")).rejects.toBeInstanceOf(PathError);
  });

  it("rejects directories", async () => {
    const repo = await makeRepo({ "src/a.ts": "x" });
    await expect(readRepoFile(repo, "src")).rejects.toBeInstanceOf(PathError);
  });
});

describe("parseDiffNewLines", () => {
  it("collects new-side line numbers from hunk headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "@@ -3,0 +4,2 @@",
      "+added",
      "+added",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      "@@ -20,3 +23,0 @@",
    ].join("\n");
    expect(parseDiffNewLines(diff)).toEqual([4, 5, 12]);
  });
});

describe("changedLines", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd });

  it("returns modified lines vs HEAD, all lines for untracked files, [] outside git", async () => {
    const repo = await makeRepo({ "a.ts": "one\ntwo\nthree\n" });
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    await fs.writeFile(path.join(repo, "a.ts"), "one\nTWO\nthree\nfour\n");
    await fs.writeFile(path.join(repo, "new.ts"), "a\nb\n");

    expect(await changedLines(repo, "a.ts", 5)).toEqual([2, 4]);
    expect(await changedLines(repo, "new.ts", 3)).toEqual([1, 2, 3]);

    const plain = await makeRepo({ "a.ts": "x" });
    expect(await changedLines(plain, "a.ts", 1)).toEqual([]);
  });
});

describe("reanchor", () => {
  const file = ["import x", "", "function a() {", "  return s.user", "}", "", "function b() {", "  return s.user", "}"].join("\n");

  it("exact when the snippet is still at its lines (indentation-insensitive)", () => {
    expect(reanchor(file, { lineStart: 4, lineEnd: 4, snippet: "return s.user" })).toEqual({
      lineStart: 4, lineEnd: 4, anchor: "exact",
    });
  });

  it("moved when lines were inserted above", () => {
    const edited = "// new header\n// another\n" + file;
    expect(reanchor(edited, { lineStart: 3, lineEnd: 4, snippet: "function a() {\n  return s.user" })).toEqual({
      lineStart: 5, lineEnd: 6, anchor: "moved",
    });
  });

  it("picks the match nearest the original line when there are several", () => {
    const edited = "// x\n" + file; // "return s.user" now at 5 and 9
    expect(reanchor(edited, { lineStart: 8, lineEnd: 8, snippet: "return s.user" })).toEqual({
      lineStart: 9, lineEnd: 9, anchor: "moved",
    });
  });

  it("lost when the snippet is gone", () => {
    expect(reanchor(file, { lineStart: 4, lineEnd: 4, snippet: "return s.admin" })).toEqual({
      lineStart: 4, lineEnd: 4, anchor: "lost",
    });
  });

  it("matches a CRLF file against an LF snippet with a trailing newline", () => {
    const crlf = file.replace(/\n/g, "\r\n");
    expect(reanchor(crlf, { lineStart: 3, lineEnd: 4, snippet: "function a() {\n  return s.user\n" })).toEqual({
      lineStart: 3, lineEnd: 4, anchor: "exact",
    });
  });

  it("lost when the original range runs past the end of the file and the snippet is gone", () => {
    expect(reanchor("a\nb", { lineStart: 50, lineEnd: 51, snippet: "zzz" }).anchor).toBe("lost");
  });
});

describe("anchorFinding", () => {
  it("reports missing files as lost + exists:false", async () => {
    const repo = await makeRepo({});
    expect(await anchorFinding(repo, { file: "gone.ts", lineStart: 2, lineEnd: 3, snippet: "x" })).toEqual({
      lineStart: 2, lineEnd: 3, anchor: "lost", exists: false,
    });
  });
});
