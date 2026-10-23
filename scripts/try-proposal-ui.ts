// Dev helper: a throwaway server (scratch home, port 4480) seeded with proposals over this repo, for screenshots of
// Proposals mode. Decisions go to a spy courier (printed), so nothing reaches a real Claude session. Ctrl+C to stop.
// Usage: npx tsx scripts/try-proposal-ui.ts   then   SCREENSHOT_URL=http://127.0.0.1:4480/ npm run screenshot -- mode.png
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listLiveSessions } from "../src/server/claude-sessions";
import { startServer } from "../src/server/index";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-proposal-ui-"));
const srv = await startServer({
  port: Number(process.env.PORT ?? 4480),
  home,
  log: () => {},
  uiDir: path.resolve("dist/ui"),
  skillsDir: path.resolve("skills"),
  claudePath: path.resolve("tests/fake-claude/claude.cjs"),
  deliver: async (agent, text) => console.log(`courier → ${agent}: ${text}`),
});
const repo = process.cwd();
const sessionId = (await listLiveSessions())[0]?.sessionId;
const lines = (await fs.readFile(path.join(repo, "package.json"), "utf8")).split(/\r?\n/);
const pkgBefore = lines.slice(1, 4).join("\n"); // name, version, private — exact text, so the step is not stale
const readme = (await fs.readFile(path.join(repo, "README.md"), "utf8")).split(/\r?\n/)[0];

// Oldest first: the newest active proposal opens by default.
const done = await srv.proposals.create({
  repoRoot: repo,
  sessionId,
  task: { title: "Rename the stats helper", context: "Earlier task, fully handled." },
  steps: [
    { stepId: "s1", title: "Rename statsLine to statsText", kind: "edit", file: "src/ui/components/JobCard.tsx", lineStart: 20, lineEnd: 20, what: "Rename the helper.", why: "The old name suggested a DOM element.", before: "const statsLine = ", after: "const statsText = " },
    { stepId: "s2", title: "Typecheck", kind: "command", what: "Run the typecheck.", why: "Catches callers of the old name.", command: "npm run typecheck", dependsOn: ["s1"] },
  ],
});
await srv.proposals.decide(done.id, "s1", { kind: "accept" });
await srv.proposals.markStep(done.id, "s1", "applied", "Renamed in JobCard.tsx and its two callers.");
await srv.proposals.decide(done.id, "s2", { kind: "decline", text: "I'll run it myself" });
await srv.proposals.markStep(done.id, "s2", "skipped", "Declined by the user.");

await srv.proposals.create({
  repoRoot: repo,
  sessionId,
  task: { title: "Stale example", context: "A step whose before text is gone." },
  steps: [
    { stepId: "s1", title: "Change a line that no longer exists", kind: "edit", file: "package.json", lineStart: 2, lineEnd: 2, what: "Edit.", why: "Shows the stale banner.", before: '  "name": "something-else",', after: '  "name": "ferret",' },
  ],
});

const active = await srv.proposals.create({
  repoRoot: repo,
  sessionId,
  task: {
    title: "Bump the version and note it in the README",
    context: "Release prep: the package version goes to 0.2.0 and the README's first line mentions it. Typecheck afterwards.",
    planRef: "docs/superpowers/plans/2026-10-22-proposal-mode.md",
  },
  steps: [
    { stepId: "s1", title: "Bump package.json to 0.2.0", kind: "edit", file: "package.json", lineStart: 2, lineEnd: 4, what: "Set version to 0.2.0.", why: "First release with proposal mode.", before: pkgBefore, after: pkgBefore.replace('"version": "0.1.0"', '"version": "0.2.0"') },
    { stepId: "s2", title: "Mention 0.2.0 in the README title", kind: "edit", file: "README.md", lineStart: 1, lineEnd: 1, what: "Append the version to the title line.", why: "Readers see which release the README describes.", before: readme, after: `${readme} — v0.2.0`, dependsOn: ["s1"] },
    { stepId: "s3", title: "Add a CHANGELOG", kind: "create", file: "CHANGELOG.md", what: "Create the changelog with the 0.2.0 entry.", why: "There is none yet.", after: "# Changelog\n\n## 0.2.0\n\n- Proposal mode: step-by-step change approval.\n", notes: [{ at: "## 0.2.0", text: "One heading per release, newest first; entries are one line each." }] },
    { stepId: "s4", title: "Typecheck", kind: "command", what: "Run the typecheck.", why: "Nothing should break, but the command step shows its output here.", command: "npm run typecheck", dependsOn: ["s1", "s2"] },
  ],
});
await srv.proposals.decide(active.id, "s2", { kind: "ask", text: "Why the dash and not parentheses?" });
await srv.proposals.answer(active.id, "s2", "A dash reads better in the GitHub header; parentheses would wrap on narrow screens. Happy to switch.");
await srv.proposals.reviseStep(active.id, "s2", { after: `${readme} (v0.2.0)` });

console.log(`Proposals UI at ${srv.url}/p/${active.id}  (home ${home}; courier is a spy${sessionId ? `, sessionId ${sessionId}` : ""})`);
