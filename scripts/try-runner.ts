// Dev helper: exercises the headless runner with the fake claude in each mode.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClaudeArgs, childEnv, parseStreamLine, runClaude, type RunOptions } from "../src/server/claude-runner";

const fake = path.resolve("tests/fake-claude/claude.cjs");
const log = path.join(os.tmpdir(), "fake-claude-log.json");
const base: RunOptions = {
  prompt: 'review this: "quotes" & ampersand\nnewline ł',
  cwd: process.cwd(),
  addDirs: ["C:/x/wt"],
  allowedTools: ["Read", "Grep", "Glob", "Bash(git diff *)"],
  mcp: { name: "review-app", url: "http://127.0.0.1:4477/mcp" },
  outputFormat: "stream-json",
  timeoutMs: 20_000,
  claudePath: fake,
};

console.log("args:", buildClaudeArgs(base));
console.log("env drops:", "ELECTRON_RUN_AS_NODE" in childEnv({ ELECTRON_RUN_AS_NODE: "1", CLAUDECODE: "1", PATH: "p" }), "CLAUDECODE" in childEnv({ CLAUDECODE: "1" }));
console.log("parse tool_use:", parseStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "C:/r/src/a.ts" } } ] } })));
console.log("parse result:", parseStreamLine(JSON.stringify({ type: "result", is_error: false, result: "done" })), "| garbage:", parseStreamLine("nope"));

async function run(mode: string, extra: Partial<RunOptions> = {}) {
  const h = runClaude({ ...base, ...extra, env: { ...childEnv(), FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log } });
  const progress: string[] = [];
  h.on("progress", (p) => progress.push(p));
  return { h, progress };
}

let { h, progress } = await run("ok");
let r = await h.done;
console.log("ok →", { ok: r.ok, exit: r.exitCode, result: r.resultText, progress });
const seen = JSON.parse(await fs.readFile(log, "utf8"));
console.log("prompt intact:", seen.prompt === base.prompt, "| child env ELECTRON_RUN_AS_NODE:", seen.env.ELECTRON_RUN_AS_NODE, "(node mode only)", "| cwd:", seen.cwd);

({ h } = await run("error"));
r = await h.done;
console.log("error →", { ok: r.ok, exit: r.exitCode, tail: r.logTail.slice(-1) });

({ h } = await run("hang", { timeoutMs: 1500 }));
const t0 = Date.now();
r = await h.done;
console.log("hang+timeout →", { timedOut: r.timedOut, cancelled: r.cancelled, ms: Date.now() - t0 });

({ h } = await run("hang"));
setTimeout(() => h.cancel(), 300);
r = await h.done;
let alive = true;
try { process.kill(h.pid!, 0); } catch { alive = false; }
console.log("hang+cancel →", { cancelled: r.cancelled, pidAlive: alive });

({ h } = await run("ok", { outputFormat: "json", mcp: undefined }));
r = await h.done;
console.log("json mode →", { ok: r.ok, result: r.resultText.slice(0, 40) });
