// Dev helper: the portable review schema must reject revisions/urls that could steer git or the browser.
// Expected: good → true; every bad payload → an error; a fence quoted inside a finding body still parses.
import { FENCE, parseExport } from "../src/shared/export";

const mk = (source: object, summary = "s") =>
  `# x\n\n${FENCE}\n${JSON.stringify({
    formatVersion: 1,
    review: { id: "r_1", createdAt: "2026-10-17T00:00:00Z", scope: { kind: "files", target: ["a"] }, summary, agent: "claude", source, findings: [] },
  })}\n\`\`\`\n`;
const good = { kind: "pr", repoName: "x", head: "9da69f9c6654d123027355692f40cf5d15ba2088", base: "origin/main", url: "https://github.com/a/b/pull/1" };
console.log("good:", parseExport(mk(good)).ok);
for (const bad of [
  { ...good, base: "--output=C:/x.bat" },
  { ...good, head: "refs/heads/main" },
  { ...good, head: "" },
  { ...good, base: "a b" },
  { ...good, url: "javascript:alert(1)" },
]) {
  const r = parseExport(mk(bad));
  console.log("bad:", r.ok ? "ACCEPTED (wrong)" : r.error);
}
const quoted = mk(good).replace("# x", `# x\n\nbody mentions ${FENCE} inside text`);
console.log("fence quoted in body:", parseExport(quoted).ok);
