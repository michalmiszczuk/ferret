import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findPackageDir, installSkills, SKILL_NAMES } from "../../src/cli/setup";
import { tmpDir } from "../helpers";

const pkgDir = findPackageDir(fileURLToPath(import.meta.url));

describe("findPackageDir", () => {
  it("finds the review-app package root", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("review-app");
  });
});

describe("skills", () => {
  it.each(SKILL_NAMES)("%s has matching frontmatter name and references the MCP tools", async (name) => {
    const text = await fs.readFile(path.join(pkgDir, "skills", name, "SKILL.md"), "utf8");
    expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`, "m"));
    const tools = name === "ai-review" ? ["submit_review"] : ["get_pending_actions", "mark_done"];
    for (const t of tools) expect(text).toContain(t);
  });
});

describe("installSkills", () => {
  it("copies each SKILL.md into <claudeHome>/skills/<name>/, overwriting old versions", async () => {
    const claudeHome = await tmpDir("review-app-claude-");
    await fs.mkdir(path.join(claudeHome, "skills", "ai-review"), { recursive: true });
    await fs.writeFile(path.join(claudeHome, "skills", "ai-review", "SKILL.md"), "old");

    const dirs = await installSkills(path.join(pkgDir, "skills"), claudeHome);

    expect(dirs).toEqual(SKILL_NAMES.map((n) => path.join(claudeHome, "skills", n)));
    for (const n of SKILL_NAMES) {
      const installed = await fs.readFile(path.join(claudeHome, "skills", n, "SKILL.md"), "utf8");
      expect(installed).toContain(`name: ${n}`);
    }
  });
});
