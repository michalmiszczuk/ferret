// Finds the Claude Code chat the user most recently used in a folder, so "Send to Claude" can return to it.
// Claude Code stores every session as ~/.claude/projects/<folder encoded>/<sessionId>.jsonl; the newest file is
// the chat the user is in (VS Code appends to it on every message).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LatestSession {
  sessionId: string;
  modifiedAt: string;
}

/** A running Claude Code session (VS Code or terminal) that can receive cross-session messages. */
export interface LiveSession {
  name: string;
  sessionId: string;
  cwd: string;
  status: string; // "idle" | "busy" | …
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/** Claude Code's project-folder name: every non-alphanumeric character becomes "-" (case kept as the cwd was given). */
export function encodeProjectDir(dir: string): string {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-");
}

/** Every live interactive session from ~/.claude/sessions (one registry file per process; stale pids are skipped). */
export async function listLiveSessions(home = claudeHome()): Promise<LiveSession[]> {
  const dir = path.join(home, "sessions");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const file of names.filter((n) => /^\d+\.json$/.test(n))) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as {
        pid?: number;
        sessionId?: string;
        cwd?: string;
        name?: string;
        status?: string;
        kind?: string;
      };
      if (j.kind !== "interactive" || !j.name || !j.cwd || !j.sessionId || !j.pid) continue;
      try {
        process.kill(j.pid, 0); // throws when the process is gone
      } catch {
        continue;
      }
      out.push({ name: j.name, sessionId: j.sessionId, cwd: j.cwd, status: j.status ?? "unknown" });
    } catch {
      // unreadable registry entry
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function latestSession(dir: string, home = claudeHome()): Promise<LatestSession | null> {
  const projects = path.join(home, "projects");
  const wanted = encodeProjectDir(dir).toLowerCase();
  let names: string[];
  try {
    names = await fs.readdir(projects);
  } catch {
    return null;
  }
  let best: LatestSession | null = null;
  // The drive letter's case differs by launcher (VS Code: "c:", a terminal: "C:"), so compare case-insensitively.
  for (const name of names.filter((n) => n.toLowerCase() === wanted)) {
    const folder = path.join(projects, name);
    let files: string[];
    try {
      files = await fs.readdir(folder);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = await fs.stat(path.join(folder, f));
        if (!st.isFile()) continue;
        const modifiedAt = st.mtime.toISOString();
        if (!best || modifiedAt > best.modifiedAt) best = { sessionId: f.slice(0, -".jsonl".length), modifiedAt };
      } catch {
        // skip unreadable entries
      }
    }
  }
  return best;
}
