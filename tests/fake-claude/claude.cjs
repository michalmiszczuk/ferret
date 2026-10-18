#!/usr/bin/env node
// A stand-in for the `claude` CLI so the review pipeline can be exercised without spending Claude usage.
// Modes (env FAKE_CLAUDE_MODE): ok | error | hang | submit. FAKE_CLAUDE_LOG=<file> records cwd/argv/env.
const fs = require("node:fs");
const http = require("node:http");

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = arg("-p") || "";

if (process.env.FAKE_CLAUDE_LOG) {
  fs.writeFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ cwd: process.cwd(), argv, env: { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE, CLAUDECODE: process.env.CLAUDECODE }, prompt }, null, 2),
  );
}

const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const assistant = (block) => line({ type: "assistant", message: { content: [block] } });
const result = (text, isError = false) => line({ type: "result", subtype: isError ? "error" : "success", is_error: isError, result: text });

async function submitReview() {
  const cfg = arg("--mcp-config");
  const url = cfg ? Object.values(JSON.parse(cfg).mcpServers)[0].url : "http://127.0.0.1:4477/mcp";
  const jobId = (prompt.match(/jobId: "([^"]+)"/) || [])[1];
  const checkout = (prompt.match(/repoRoot: "([^"]+)"/) || [])[1] || process.cwd();
  const files = (prompt.match(/Changed files:\n([\s\S]*?)\n\n/) || [, ""])[1].split("\n").map((s) => s.replace(/^- /, "").trim()).filter(Boolean);
  const file = files[0] || "README.md";
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "submit_review",
      arguments: {
        repoRoot: checkout,
        scope: { kind: "files", target: files.length ? files : ["."] },
        summary: "Fake review from tests/fake-claude",
        jobId,
        findings: [
          { severity: "high", title: "Fake: first line looks suspicious", body: "Fake finding.", category: "bug", file, lineStart: 1, lineEnd: 1, snippet: fs.existsSync(require("node:path").join(checkout, file)) ? fs.readFileSync(require("node:path").join(checkout, file), "utf8").split(/\r?\n/)[0] : "x" },
          { severity: "low", title: "Fake: nit", body: "Fake nit.", category: "style", file, lineStart: 1, lineEnd: 1, snippet: "x" },
        ],
      },
    },
  };
  await new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          process.stderr.write(`submit_review → ${res.statusCode}\n`);
          resolve();
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

(async () => {
  if (mode === "error") {
    process.stderr.write("boom: fake failure\n");
    process.exit(2);
  }
  const streaming = arg("--output-format") !== "json"; // the real CLI prints only the final object in json mode
  if (mode === "hang") {
    // A slow "review": some activity first (so the live feed has something to show), then it never finishes.
    if (streaming) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      assistant({ type: "tool_use", name: "Read", input: { file_path: "C:/x/j_1.diff" } });
      await sleep(400);
      assistant({ type: "text", text: "The change touches the HTML sanitizer; checking the callers." });
      await sleep(400);
      assistant({ type: "tool_use", name: "Grep", input: { pattern: "sanitizeHtml" } });
      await sleep(400);
      assistant({ type: "tool_use", name: "Read", input: { file_path: "apps/frontend/src/rich-text/sanitize.ts" } });
      await sleep(400);
      assistant({ type: "tool_use", name: "Read", input: { file_path: "apps/frontend/src/rich-text/RichTextLabel.tsx" } });
    }
    await new Promise((r) => setTimeout(r, 60_000));
    process.exit(0);
  }
  if (streaming) {
    assistant({ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } });
    assistant({ type: "tool_use", name: "Bash", input: { command: "git diff HEAD" } });
  }
  if (mode === "submit") {
    if (streaming) assistant({ type: "tool_use", name: "mcp__review-app__submit_review", input: {} });
    await submitReview();
  }
  if (arg("--output-format") === "json") {
    line({ type: "result", subtype: "success", is_error: false, result: "Nice catch: the sanitizer falls open when no DOM is available; consider rendering plain text in that case." });
  } else {
    result("done");
  }
})().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exit(1);
});
