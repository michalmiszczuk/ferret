// Dev helper: a chat hands a review to Ferret via the start_review MCP tool, with notes; checks the notes reach the
// reviewer's prompt. Uses the fake claude, so it costs nothing.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/index";
import { listCommits } from "../src/server/scope";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-start-"));
const fakeLog = path.join(home, "fake.json");
process.env.FAKE_CLAUDE_MODE = "submit";
process.env.FAKE_CLAUDE_LOG = fakeLog;
const srv = await startServer({ port: 0, home, log: () => {}, skillsDir: path.resolve("skills"), claudePath: path.resolve("tests/fake-claude/claude.cjs") });

const client = new Client({ name: "chat", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
const sha = (await listCommits(process.cwd(), 2))[1].sha;
const r = (await client.callTool({
  name: "start_review",
  arguments: {
    repo: process.cwd(),
    scope: { commit: sha },
    notes: "We moved the loader into the card on purpose; the user worries the stats line breaks on drafts.",
  },
})) as { content: { text: string }[]; isError?: boolean };
console.log("start_review →", r.isError ? "ERROR" : "ok", r.content[0].text.slice(0, 120));
const { jobId } = JSON.parse(r.content[0].text) as { jobId: string };

for (let i = 0; i < 60; i++) {
  const job = srv.jobs.get(jobId)!;
  if (["done", "failed", "cancelled"].includes(job.status)) {
    console.log("job:", job.status, "notes kept:", Boolean(job.notes), "review:", job.reviewId);
    break;
  }
  await new Promise((res) => setTimeout(res, 500));
}
const seen = JSON.parse(await fs.readFile(fakeLog, "utf8")) as { prompt: string };
console.log("prompt has notes section:", seen.prompt.includes("## Notes from the requester"), "| has the note text:", seen.prompt.includes("loader into the card"));
await client.close();
await srv.close();
await fs.rm(home, { recursive: true, force: true });
process.exit(0);
