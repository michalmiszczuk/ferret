// Dev helper: draws one of your stored reviews on the running Whiteboard. Usage: npx tsx scripts/try-whiteboard.ts [reviewId]
// Picks the newest PR review when no id is given. Creates a real Whiteboard review (trash it in Whiteboard afterwards).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewSchema } from "../src/shared/schema";
import { createWhiteboard, findWhiteboardConfig } from "../src/server/whiteboard";

// `--outline <sessionId>` only reads a Whiteboard back (exercises the ensure-running path without creating anything).
if (process.argv[2] === "--outline") {
  const wb0 = createWhiteboard({ log: console.log });
  const text = await wb0.readOutline(process.argv[3]);
  console.log(`outline: ${text.length} chars; first line: ${text.split("\n")[0]}`);
  process.exit(0);
}

const home = process.env.REVIEW_APP_HOME ?? path.join(os.homedir(), ".review-app");
const dir = path.join(home, "reviews");
const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
const reviews = [];
for (const f of files) reviews.push(reviewSchema.parse(JSON.parse(await fs.readFile(path.join(dir, f), "utf8"))));
reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const wanted = process.argv[2];
const review = wanted ? reviews.find((r) => r.id === wanted) : reviews.find((r) => r.source?.kind === "pr") ?? reviews[0];
if (!review) throw new Error("no review found");
console.log("review:", review.id, review.source?.kind, review.source?.url ?? review.repoRoot, "findings:", review.findings.length);

console.log("config:", await findWhiteboardConfig());
const wb = createWhiteboard({ log: console.log });
console.log("status:", await wb.status());
const t0 = Date.now();
const { sessionId } = await wb.publish(review);
console.log(`published in ${Math.round((Date.now() - t0) / 1000)}s → session ${sessionId}`);
