import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/server/index";
import type { Finding, SubmitReviewInput } from "../src/shared/schema";

export async function startTestServer(): Promise<RunningServer & { home: string }> {
  const home = await tmpDir("review-app-home-");
  const server = await startServer({ port: 0, home, log: () => {} });
  return { ...server, home };
}

export function makeFinding(o: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    severity: "medium",
    originalSeverity: o.severity ?? "medium",
    title: "Something is off",
    body: "Body text",
    category: "bug",
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 1,
    snippet: "x",
    status: "open",
    updatedAt: "2026-10-15T00:00:00.000Z",
    ...o,
  };
}

export function makeReviewInput(
  repoRoot: string,
  findings: SubmitReviewInput["findings"] = [
    { severity: "low", title: "Nit", body: "Rename", category: "style", file: "src/a.ts", lineStart: 1, lineEnd: 1, snippet: "line1" },
    { severity: "critical", title: "Crash", body: "Null deref", category: "bug", file: "src/a.ts", lineStart: 2, lineEnd: 2, snippet: "const x = 1;" },
  ],
): SubmitReviewInput {
  return { repoRoot, scope: { kind: "diff", target: "uncommitted" }, summary: "Test review", findings };
}

export async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Creates a temp directory with the given files (repo-relative path → content). Returns its absolute path. */
export async function makeRepo(files: Record<string, string>, parent?: string): Promise<string> {
  const dir = parent ? parent : await tmpDir("review-app-repo-");
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}
