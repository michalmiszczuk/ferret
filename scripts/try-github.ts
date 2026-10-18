// Dev helper: checks the gh wrapper against a real repo. Usage: npx tsx scripts/try-github.ts <repoPath> [prNumber]
import { createGithub } from "../src/server/github";

const [repo, pr] = process.argv.slice(2);
const gh = createGithub();
console.log("status:", await gh.status());
if (repo) {
  const prs = await gh.listPrs(repo);
  console.log(`open PRs (${prs.length}):`, prs.slice(0, 5).map((p) => `#${p.number} ${p.title} (${p.author})`));
  if (pr) console.log("prInfo:", await gh.prInfo(repo, Number(pr)));
}
