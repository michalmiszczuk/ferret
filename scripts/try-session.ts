// Dev helper: which Claude Code chat was used most recently in a folder? Usage: npx tsx scripts/try-session.ts [dir]
import { encodeProjectDir, latestSession } from "../src/server/claude-sessions";

const dir = process.argv[2] ?? process.cwd();
console.log("folder name:", encodeProjectDir(dir));
console.log("latest session:", await latestSession(dir));
console.log("unknown folder:", await latestSession("C:/nowhere/at/all"));
