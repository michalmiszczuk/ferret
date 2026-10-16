import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { findPackageDir } from "../../src/cli/setup";
import { createClaudeIntegration } from "../../src/server/claude";
import { tmpDir } from "../helpers";

const skillsDir = path.join(findPackageDir(fileURLToPath(import.meta.url)), "skills");
const mcpUrl = "http://127.0.0.1:4477/mcp";

async function setup(claudeJson?: unknown) {
  const home = await tmpDir("review-app-claudehome-");
  const claudeHome = path.join(home, ".claude");
  const claudeJsonPath = path.join(home, ".claude.json");
  if (claudeJson !== undefined) await fs.writeFile(claudeJsonPath, JSON.stringify(claudeJson));
  const register = vi.fn(async () => ({ ok: true, output: "" }));
  const integration = createClaudeIntegration({ skillsDir, claudeHome, claudeJsonPath, mcpUrl, register });
  return { claudeHome, claudeJsonPath, register, integration };
}

describe("Claude integration status", () => {
  it("is not connected on a fresh machine", async () => {
    const { integration } = await setup();
    expect(await integration.status()).toEqual({
      connected: false, skillsInstalled: false, skillsOutdated: false, mcpRegistered: false,
    });
  });

  it("detects the MCP server registered in ~/.claude.json (user scope)", async () => {
    const { integration } = await setup({ mcpServers: { "review-app": { type: "http", url: mcpUrl } } });
    expect((await integration.status()).mcpRegistered).toBe(true);
  });

  it("treats an unreadable ~/.claude.json as not registered", async () => {
    const { integration, claudeJsonPath } = await setup();
    await fs.writeFile(claudeJsonPath, "{ not json");
    expect((await integration.status()).mcpRegistered).toBe(false);
  });
});

describe("Claude integration connect", () => {
  it("installs both skills, registers the MCP server and reports success", async () => {
    const { integration, register, claudeHome } = await setup();
    const res = await integration.connect();
    expect(register).toHaveBeenCalledWith(mcpUrl);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Registered MCP server 'review-app'");
    await expect(fs.stat(path.join(claudeHome, "skills", "ai-review", "SKILL.md"))).resolves.toBeTruthy();
    expect((await integration.status()).skillsInstalled).toBe(true);
  });

  it("counts 'already registered' as connected", async () => {
    const { integration, register } = await setup();
    register.mockResolvedValueOnce({ ok: false, output: "MCP server review-app already exists in user config" });
    const res = await integration.connect();
    expect(res.ok).toBe(true);
  });

  it("reports a failed registration with the manual command", async () => {
    const { integration, register } = await setup();
    register.mockResolvedValueOnce({ ok: false, output: "'claude' is not recognized" });
    const res = await integration.connect();
    expect(res.ok).toBe(false);
    expect(res.message).toContain("claude mcp add --transport http --scope user review-app");
  });
});
