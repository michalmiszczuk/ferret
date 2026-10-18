// Dev helper: starts a throwaway server (scratch home, random port) and calls prepare_review_scope + submit_review over MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server/index";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-mcp-"));
const srv = await startServer({ port: 0, home, log: () => {}, skillsDir: path.resolve("skills") });
const client = new Client({ name: "try", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

console.log("tools:", (await client.listTools()).tools.map((t) => t.name));
const prepared = text(await call("prepare_review_scope", { repo: process.cwd(), scope: "changes" }));
console.log("prepare changes →", { scopeId: prepared.scopeId, checkout: prepared.checkout, files: prepared.changedFiles.length, diff: prepared.diffCommand });
const submitted = text(
  await call("submit_review", {
    repoRoot: prepared.checkout,
    scope: { kind: "files", target: prepared.changedFiles },
    summary: "try",
    scopeId: prepared.scopeId,
    findings: [{ severity: "low", title: "t", body: "b", category: "style", file: prepared.changedFiles[0] ?? "README.md", lineStart: 1, lineEnd: 1, snippet: "x" }],
  }),
);
const stored = srv.store.get(submitted.reviewId)!;
console.log("submitted with scopeId → source:", stored.source?.kind, "| repoRoot === checkout:", stored.repoRoot === prepared.checkout);
const bad = await call("prepare_review_scope", { repo: process.cwd(), scope: { commit: "zzzz" } });
console.log("bad commit → isError:", bad.isError, (bad as { content: { text: string }[] }).content[0].text);
const unknown = await call("submit_review", { repoRoot: process.cwd(), scope: { kind: "diff", target: "uncommitted" }, summary: "s", jobId: "j_nope", findings: [] });
console.log("unknown jobId → isError:", unknown.isError, (unknown as { content: { text: string }[] }).content[0].text);
const range = text(await call("prepare_review_scope", { repo: process.cwd(), scope: { range: "HEAD~2..HEAD" } }));
console.log("prepare range →", range.label, "| worktree:", range.isWorktree, "| files:", range.changedFiles.length);
await client.close();
await srv.close();
process.exit(0);
