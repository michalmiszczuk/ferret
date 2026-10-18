// Dev helper: starts a throwaway server (scratch home, port 4478) with the fake claude in `hang` mode so the UI
// shows a running job, then keeps it up for screenshots. Ctrl+C to stop.
// Usage: npx tsx scripts/try-ui.ts   then   SCREENSHOT_URL=http://127.0.0.1:4478/?panel=review npm run screenshot -- out.png
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/index";
import { listCommits } from "../src/server/scope";

process.env.FAKE_CLAUDE_MODE = process.env.FAKE_CLAUDE_MODE ?? "hang";
const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-ui-"));
const srv = await startServer({
  port: Number(process.env.PORT ?? 4478),
  home,
  log: () => {},
  uiDir: path.resolve("dist/ui"),
  skillsDir: path.resolve("skills"),
  claudePath: path.resolve("tests/fake-claude/claude.cjs"),
});
const repo = process.cwd();
const older = (await listCommits(repo, 2))[1].sha;
await srv.store.create(
  {
    repoRoot: repo,
    scope: { kind: "files", target: ["package.json"] },
    summary: "A seeded review with a source.",
    findings: [{ severity: "medium", title: "Seeded finding", body: "Body", category: "bug", file: "package.json", lineStart: 3, lineEnd: 3, snippet: '  "version": "0.1.0",' }],
  },
  { source: { kind: "pr", host: "github", url: "https://github.com/synergycodes/workflowbuilder/pull/218", number: 218, title: "Sanitize RichText label HTML", author: "Kuba-Skibinski", repoName: "workflowbuilder", repo, head: older, base: "origin/main", checkout: repo, worktree: false } },
);
srv.jobs.startReview({ type: "commit", repo, sha: older }); // hangs → a running job card
srv.jobs.startReview({ type: "changes", repo }); // queued behind it
console.log(`UI with a running job at ${srv.url}  (home ${home})`);
