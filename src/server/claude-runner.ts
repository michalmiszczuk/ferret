// Runs Claude Code headless (`claude -p …`) with a read-only tool allowlist and streams its progress.
// Knows nothing about reviews: a prompt, a cwd, a tool set, and a result.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export interface RunOptions {
  prompt: string;
  cwd: string;
  addDirs?: string[];
  allowedTools: string[];
  mcp?: { name: string; url: string };
  /** Full mcpServers map (stdio or http); takes precedence over `mcp`. */
  mcpServers?: Record<string, unknown>;
  outputFormat: "stream-json" | "json";
  timeoutMs: number;
  /** Model alias or id passed as --model (the user's interactive default may not be usable headless). */
  model?: string;
  /** The claude executable; a .js/.cjs/.mjs path is run with node (the fake CLI in tests). Default: "claude" on PATH. */
  claudePath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  resultText: string;
  isError: boolean;
  logTail: string[]; // last 60 lines of stdout+stderr
  cancelled: boolean;
  timedOut: boolean;
}

export type RunnerEvent = { type: "progress"; text: string } | { type: "result"; text: string; isError: boolean };

export function buildClaudeArgs(o: RunOptions): string[] {
  const args = [
    "-p",
    o.prompt,
    "--output-format",
    o.outputFormat,
    ...(o.outputFormat === "stream-json" ? ["--verbose"] : []), // the CLI requires it for stream-json in print mode
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    o.allowedTools.join(" "),
    ...(o.model ? ["--model", o.model] : []),
    ...(o.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    // Never load a project's settings/hooks/.mcp.json, whatever the cwd is: only the user's own settings and the
    // MCP servers we pass apply. (Without --mcp-config, --strict-mcp-config means "no MCP servers".)
    "--setting-sources",
    "user",
    "--strict-mcp-config",
  ];
  if (o.mcpServers) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: o.mcpServers }));
  } else if (o.mcp) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: { [o.mcp.name]: { type: "http", url: o.mcp.url } } }));
  }
  return args;
}

/**
 * The child's environment: the user's, minus the variables that would make claude misbehave when the app was launched
 * from a VS Code terminal, and minus the opt-in that would load CLAUDE.md from --add-dir folders (a PR's snapshot).
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
  return env;
}

/** One line of `--output-format stream-json` → a progress text, the final result, or nothing of interest. */
export function parseStreamLine(line: string): RunnerEvent | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j.type === "result") {
    return { type: "result", text: typeof j.result === "string" ? j.result : "", isError: Boolean(j.is_error) };
  }
  if (j.type === "assistant") {
    const content = (j.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const name = String(block.name ?? "");
        if (name === "Read" && typeof input.file_path === "string") return { type: "progress", text: `Reading ${shortPath(input.file_path)}` };
        if (name === "Bash" && typeof input.command === "string") return { type: "progress", text: `Running ${input.command.slice(0, 60)}` };
        if (name === "Grep" || name === "Glob") return { type: "progress", text: `Searching ${String(input.pattern ?? "").slice(0, 40)}` };
        if (name.startsWith("mcp__")) return { type: "progress", text: name.endsWith("submit_review") ? "Submitting findings…" : name };
        return { type: "progress", text: name };
      }
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        return { type: "progress", text: block.text.trim().slice(0, 80) };
      }
    }
  }
  return null;
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

export class RunHandle extends EventEmitter {
  done: Promise<RunResult>;
  pid?: number;
  private child?: ChildProcess;
  private cancelled = false;
  private timedOut = false;
  private resolveDone!: (r: RunResult) => void;

  constructor(private readonly o: RunOptions) {
    super();
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  start(): this {
    const args = buildClaudeArgs(this.o);
    const exe = this.o.claudePath ?? "claude";
    const env = this.o.env ?? childEnv();
    const viaNode = /\.(c|m)?js$/i.test(exe);
    // stdin closed: otherwise the CLI waits 3 s for piped input before starting.
    const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
    const child = viaNode
      ? spawn(process.execPath, [exe, ...args], { cwd: this.o.cwd, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio })
      : spawn(exe, args, { cwd: this.o.cwd, env, windowsHide: true, stdio });
    this.child = child;
    this.pid = child.pid;

    const log: string[] = [];
    const push = (line: string) => {
      log.push(line);
      if (log.length > 60) log.shift();
      this.emit("log", line);
    };
    let resultText = "";
    let isError = false;
    let sawResult = false;

    const out = readline.createInterface({ input: child.stdout! });
    out.on("line", (line) => {
      push(line);
      if (this.o.outputFormat === "stream-json") {
        const ev = parseStreamLine(line);
        if (ev?.type === "progress") this.emit("progress", ev.text);
        else if (ev?.type === "result") {
          sawResult = true;
          resultText = ev.text;
          isError = ev.isError;
        }
      }
    });
    let stdoutAll = "";
    if (this.o.outputFormat === "json") child.stdout!.on("data", (d) => (stdoutAll += d));
    const err = readline.createInterface({ input: child.stderr! });
    err.on("line", push);

    const timer = setTimeout(() => {
      this.timedOut = true;
      this.cancel();
    }, this.o.timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      push(`spawn error: ${e.message}`);
      this.resolveDone({ ok: false, exitCode: null, resultText: "", isError: true, logTail: [...log], cancelled: false, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (this.o.outputFormat === "json" && !sawResult) {
        // `--output-format json` prints one JSON object; be tolerant of extra lines and take the result object.
        const candidates = [stdoutAll.trim(), ...stdoutAll.split(/\r?\n/).reverse()];
        let parsed = false;
        for (const c of candidates) {
          try {
            const j = JSON.parse(c) as { type?: string; result?: unknown; is_error?: boolean };
            if (typeof j.result === "string") {
              resultText = j.result;
              isError = Boolean(j.is_error);
              parsed = true;
              break;
            }
          } catch {
            // try the next candidate
          }
        }
        if (!parsed) resultText = stdoutAll.trim();
      }
      const ok = code === 0 && !isError && !this.cancelled && !this.timedOut;
      this.resolveDone({ ok, exitCode: code, resultText, isError, logTail: [...log], cancelled: this.cancelled, timedOut: this.timedOut });
    });
    return this;
  }

  cancel(): void {
    if (!this.child || this.child.exitCode !== null) return;
    this.cancelled = true;
    if (process.platform === "win32" && this.child.pid) {
      execFile("taskkill", ["/T", "/F", "/PID", String(this.child.pid)], { windowsHide: true }, () => {});
    } else {
      this.child.kill("SIGTERM");
    }
  }
}

export function runClaude(o: RunOptions): RunHandle {
  return new RunHandle(o).start();
}

/** Is the claude CLI reachable (for /api/env)? */
export function claudeInstalled(claudePath = "claude"): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    execFile(claudePath, ["--version"], { env: childEnv(), windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve({ installed: false });
      resolve({ installed: true, version: String(stdout).trim().split(/\s+/)[0] });
    });
  });
}
