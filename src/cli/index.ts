import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeIntegration } from "../server/claude";
import { startServer } from "../server/index";
import { openWithOs } from "../server/open-external";
import { findPackageDir, installSkills, registerMcp, registrationMessage } from "./setup";

const PORT = 4477;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "start";
  const pkgDir = findPackageDir(fileURLToPath(import.meta.url));

  if (cmd === "start") {
    const uiDir = path.join(pkgDir, "dist", "ui");
    try {
      const s = await startServer({
        port: PORT,
        uiDir: existsSync(path.join(uiDir, "index.html")) ? uiDir : undefined,
        claude: createClaudeIntegration({ skillsDir: path.join(pkgDir, "skills"), mcpUrl: `http://127.0.0.1:${PORT}/mcp` }),
        openExternal: openWithOs,
      });
      console.log(`Ferret running at ${s.url}\nMCP endpoint: ${s.url}/mcp\nPress Ctrl+C to stop.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(`Port ${PORT} is busy. Is Ferret already running? Open http://127.0.0.1:${PORT}`);
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  if (cmd === "setup") {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    for (const dir of await installSkills(path.join(pkgDir, "skills"), claudeHome)) console.log(`Installed skill: ${dir}`);
    const url = `http://127.0.0.1:${PORT}/mcp`;
    const res = await registerMcp(url);
    console.log(registrationMessage(res, url));
    return;
  }

  console.log("Usage: review-app [start|setup]");
  process.exit(1);
}

void main();
