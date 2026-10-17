import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installSkills, registerMcp, registrationMessage, SKILL_NAMES } from "../cli/setup";
import type { ClaudeConnectResult, ClaudeStatus } from "../shared/api-types";

export type { ClaudeConnectResult, ClaudeStatus };

/** Connects review-app to Claude Code: the "Connect Claude" button and the tray item both use this. */
export interface ClaudeIntegration {
  status(): Promise<ClaudeStatus>;
  connect(): Promise<ClaudeConnectResult>;
}

export interface ClaudeIntegrationOptions {
  skillsDir: string;
  mcpUrl: string;
  claudeHome?: string; // default: $CLAUDE_CONFIG_DIR or ~/.claude
  claudeJsonPath?: string; // where Claude Code keeps user-scope MCP servers; default ~/.claude.json
  register?: (url: string) => Promise<{ ok: boolean; output: string }>;
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

export function createClaudeIntegration(opts: ClaudeIntegrationOptions): ClaudeIntegration {
  const claudeHome = opts.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  // Claude Code keeps .claude.json next to the config dir when CLAUDE_CONFIG_DIR is set, else in the home dir.
  const claudeJsonPath =
    opts.claudeJsonPath ??
    (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json"));
  const register = opts.register ?? registerMcp;

  async function mcpRegistered(): Promise<boolean> {
    try {
      const json = JSON.parse(await fs.readFile(claudeJsonPath, "utf8")) as { mcpServers?: Record<string, unknown> };
      return Boolean(json.mcpServers?.["review-app"]);
    } catch {
      return false;
    }
  }

  /** Installed copy differs from the one this app ships (e.g. the app was updated) → needs reinstalling. */
  async function skillOutdated(name: string): Promise<boolean> {
    const read = (p: string) => fs.readFile(p, "utf8").then((t) => t.replace(/\r\n/g, "\n"), () => null);
    const [installed, bundled] = await Promise.all([
      read(path.join(claudeHome, "skills", name, "SKILL.md")),
      read(path.join(opts.skillsDir, name, "SKILL.md")),
    ]);
    return installed !== null && bundled !== null && installed !== bundled;
  }

  async function status(): Promise<ClaudeStatus> {
    const skills = await Promise.all(SKILL_NAMES.map((n) => exists(path.join(claudeHome, "skills", n, "SKILL.md"))));
    const skillsInstalled = skills.every(Boolean);
    const skillsOutdated = (await Promise.all(SKILL_NAMES.map(skillOutdated))).some(Boolean);
    const registered = await mcpRegistered();
    return {
      connected: skillsInstalled && !skillsOutdated && registered,
      skillsInstalled,
      skillsOutdated,
      mcpRegistered: registered,
    };
  }

  async function connect(): Promise<ClaudeConnectResult> {
    await installSkills(opts.skillsDir, claudeHome);
    const res = await register(opts.mcpUrl);
    const alreadyThere = !res.ok && /already exists/i.test(res.output);
    const ok = res.ok || alreadyThere;
    const message = ok
      ? "Claude connected. Start a new Claude Code session and run /ai-review."
      : registrationMessage(res, opts.mcpUrl);
    return { ok, message: res.ok ? `${registrationMessage(res, opts.mcpUrl)} ${message}` : message };
  }

  return { status, connect };
}
