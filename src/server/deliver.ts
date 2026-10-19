// Delivers a message into a running Claude Code session (the cross-session channel), so "Send to Claude"
// can target any open VS Code window without the user pressing Enter there. The courier is a tiny headless
// Claude run whose only allowed tool is SendMessage.
import { runClaude, type RunHandle, type RunOptions } from "./claude-runner";

export const MESSENGER_MODEL = process.env.REVIEW_APP_MESSENGER_MODEL ?? "claude-haiku-5-5";
const TIMEOUT_MS = 90_000;

export class DeliverError extends Error {}

export function buildDeliverRun(agent: string, text: string, deps: { sandboxDir: string; claudePath?: string }): RunOptions {
  const prompt = [
    `Use the SendMessage tool to send the message below to the agent named "${agent}". Send it exactly as written, nothing added or removed. Then reply with one word: sent.`,
    `If the SendMessage tool is not available, reply with one word: NOTOOL. If sending fails, reply with FAILED and the reason.`,
    "",
    "Message:",
    text,
  ].join("\n");
  return {
    prompt,
    cwd: deps.sandboxDir,
    allowedTools: ["SendMessage"],
    outputFormat: "json",
    timeoutMs: TIMEOUT_MS,
    model: MESSENGER_MODEL,
    claudePath: deps.claudePath,
  };
}

export async function deliverToSession(
  agent: string,
  text: string,
  deps: { sandboxDir: string; claudePath?: string; runner?: (o: RunOptions) => RunHandle },
): Promise<void> {
  const result = await (deps.runner ?? runClaude)(buildDeliverRun(agent, text, deps)).done;
  const reply = result.resultText.trim();
  if (result.ok && /^sent\b/i.test(reply)) return;
  if (/NOTOOL/.test(reply)) throw new DeliverError("This Claude Code version cannot message other sessions (no SendMessage tool). Use the VS Code option instead.");
  if (result.timedOut) throw new DeliverError("Delivery timed out.");
  throw new DeliverError(`Delivery failed: ${(reply || result.logTail[result.logTail.length - 1] || "courier run errored").slice(0, 200)}`);
}
