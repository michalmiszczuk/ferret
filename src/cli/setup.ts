import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

export const SKILL_NAMES = ["ai-review", "apply-review"] as const;

/** Walks up from a file to the nearest directory containing package.json (works from src/ and from dist/). */
export function findPackageDir(fromFile: string): string {
  let dir = path.dirname(fromFile);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${fromFile}`);
    dir = parent;
  }
}

export async function installSkills(srcDir: string, claudeHome: string): Promise<string[]> {
  const installed: string[] = [];
  for (const name of SKILL_NAMES) {
    const dest = path.join(claudeHome, "skills", name);
    await fs.mkdir(dest, { recursive: true });
    await fs.copyFile(path.join(srcDir, name, "SKILL.md"), path.join(dest, "SKILL.md"));
    installed.push(dest);
  }
  return installed;
}

export function registerMcp(url: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["mcp", "add", "--transport", "http", "--scope", "user", "review-app", url],
      { shell: process.platform === "win32" }, // `claude` is a .cmd shim on Windows
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.trim() }),
    );
  });
}

/** Human-readable result of registerMcp(), shared by `review-app setup` and the desktop tray action. */
export function registrationMessage(res: { ok: boolean; output: string }, url: string): string {
  if (res.ok) return "Registered MCP server 'review-app' with Claude Code (user scope).";
  return (
    `Could not register the MCP server automatically${res.output ? `:\n${res.output}` : "."}\n` +
    `If it is already registered, ignore this. Otherwise run:\n  claude mcp add --transport http --scope user review-app ${url}`
  );
}
