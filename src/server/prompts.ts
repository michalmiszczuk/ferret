// Prompts for headless runs. The review rules come from skills/ai-review/SKILL.md so chat and app reviews rate the same way.
import { DEFAULT_DRAFT_MODEL, DEFAULT_REVIEW_MODEL } from "../shared/models";
import type { Finding, Review } from "../shared/schema";
import type { RunOptions } from "./claude-runner";
import type { ResolvedScope } from "./scope";

export const REVIEW_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git show *)",
  "Bash(git log *)",
  "Bash(git ls-files *)",
  "mcp__review-app__submit_review",
];
/** Snapshot (worktree) runs get the diff as a file, so they need no shell at all. */
export const SNAPSHOT_REVIEW_TOOLS = REVIEW_TOOLS.filter((t) => !t.startsWith("Bash("));
export const DRAFT_TOOLS = ["Read", "Grep"];
export const REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
export const DRAFT_TIMEOUT_MS = 2 * 60 * 1000;
/** Headless runs name their model: the user's interactive default (e.g. a preview model) may not be available to `claude -p`. */
export const REVIEW_MODEL = process.env.REVIEW_APP_MODEL ?? DEFAULT_REVIEW_MODEL;
export const DRAFT_MODEL = process.env.REVIEW_APP_DRAFT_MODEL ?? process.env.REVIEW_APP_MODEL ?? DEFAULT_DRAFT_MODEL;

/** Sections 2–4 of the ai-review skill: what to look for, severity rules, finding fields. */
export function skillRules(skillText: string): string {
  const start = skillText.indexOf("## 2.");
  const end = skillText.indexOf("## 5.");
  if (start === -1) return skillText;
  return skillText.slice(start, end === -1 ? undefined : end).trim();
}

export function buildReviewPrompt(a: { scope: ResolvedScope; jobId: string; rules: string; diffFile?: string; context?: string }): string {
  const { scope, jobId, rules, diffFile, context } = a;
  const where = scope.isWorktree
    ? `The reviewed code is a detached snapshot at ${scope.checkout} (not the user's working copy). Read files from that folder with Read/Grep/Glob; shell commands are not available in this run.`
    : `The working directory is the repository checkout (${scope.checkout}).`;
  const how = diffFile
    ? `The full diff of the reviewed change is in the file ${diffFile}: Read it first.`
    : `Get the changes with: \`${scope.diffCommand}\`.`;
  const files = scope.changedFiles.length ? scope.changedFiles.map((f) => `- ${f}`).join("\n") : "- (none listed; use the diff)";
  return [
    "You are reviewing code and delivering the result to Ferret (MCP server `review-app`, tool `submit_review`). Do not modify any files. Do not ask questions; finish on your own.",
    "",
    rules,
    "",
    "## Review scope",
    "",
    `${scope.label}. Reviewed commit: ${scope.source.head}${scope.source.base ? `, base: ${scope.source.base}` : ""}.`,
    where,
    `${how} Read whole files for context, not just the hunks. Report issues in the changed code or issues the change causes.`,
    "",
    "Changed files:",
    files,
    "",
    ...(context
      ? [
          "## How this change works",
          "",
          "An explanation of this change was drawn on Whiteboard before this review (what/why, design, implementation walk; `review-source:` links point at repository lines). Use it as the map of the change: start from its entry points and flows, and build multi-place `steps` along them. Verify its claims against the code; it is context, not evidence.",
          "",
          context,
          "",
        ]
      : []),
    "## Submit",
    "",
    `When done, call \`submit_review\` exactly once with: \`repoRoot: "${scope.checkout.replace(/\\/g, "/")}"\`, \`scope: { "kind": "files", "target": [<the changed files you reviewed>] }\`, \`jobId: "${jobId}"\`, a one-paragraph \`summary\`, and all \`findings\` (file paths relative to repoRoot, forward slashes). If you found nothing worth reporting, still call it with an empty \`findings\` list and say so in \`summary\`.`,
    "Then reply with one short line. Do not list the findings in the reply.",
  ].join("\n");
}

export function buildDraftPrompt(a: { finding: Finding; review: Review; excerpt: string }): string {
  const { finding: f, review, excerpt } = a;
  const ctx = review.source
    ? `Context: ${review.source.kind === "pr" ? `pull request${review.source.number ? ` #${review.source.number}` : ""}${review.source.title ? ` "${review.source.title}"` : ""}${review.source.author ? ` by ${review.source.author}` : ""}` : `a ${review.source.kind} review`} in ${review.source.repoName}.`
    : "Context: a code review.";
  const steps = f.steps?.length
    ? `\nThe problem spans several places:\n${f.steps.map((s, i) => `${i + 1}. ${s.file}:${s.lineStart} — ${s.note}`).join("\n")}`
    : "";
  return [
    "Write a code-review comment for the author of this change, based on the finding below. The reviewer (a colleague) will paste it as a PR comment.",
    "",
    "Shape: one sentence on what is wrong and why it matters; the location (file and line); the suggested change, as a short code block when that is clearer than words. Friendly and direct, no greeting, no sign-off, at most 120 words. Output only the comment text, no preamble.",
    "",
    ctx,
    "",
    `Finding (${f.severity}, ${f.category}): ${f.title}`,
    `Location: ${f.file}:${f.lineStart}${f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}`,
    "",
    f.body,
    f.suggestion ? `\nSuggested fix from the review:\n${f.suggestion}` : "",
    steps,
    "",
    "Code around the location:",
    "```",
    excerpt,
    "```",
  ].join("\n");
}

export function buildReviewRun(
  scope: ResolvedScope,
  jobId: string,
  deps: { rules: string; mcpUrl: string; sandboxDir: string; claudePath?: string; diffFile?: string; model?: string; context?: string },
): RunOptions {
  return {
    prompt: buildReviewPrompt({ scope, jobId, rules: deps.rules, diffFile: deps.diffFile, context: deps.context }),
    // Worktree scopes run from a neutral folder so a PR branch's CLAUDE.md / hooks are never loaded.
    cwd: scope.isWorktree ? deps.sandboxDir : scope.checkout,
    addDirs: scope.isWorktree ? [scope.checkout] : undefined,
    allowedTools: scope.isWorktree ? SNAPSHOT_REVIEW_TOOLS : REVIEW_TOOLS,
    mcp: { name: "review-app", url: deps.mcpUrl },
    outputFormat: "stream-json",
    timeoutMs: REVIEW_TIMEOUT_MS,
    model: deps.model ?? REVIEW_MODEL,
    claudePath: deps.claudePath,
  };
}

/** The "explain first" pass: Claude writes the Whiteboard document for the change before the review runs. */
export const EXPLAIN_TIMEOUT_MS = 15 * 60 * 1000;

export function buildExplainPrompt(a: { scope: ResolvedScope; sessionId: string; diffFile?: string }): string {
  const { scope, sessionId, diffFile } = a;
  const s = scope.source;
  const pinned = s.base ? `\`${s.base}..${s.head}\`` : `\`${s.head}\``;
  return [
    `Write the Whiteboard for this change. A Whiteboard review already exists for it: sessionId \`${sessionId}\`, pinned to ${pinned} in \`${s.repo.replace(/\\/g, "/")}\` (${scope.label}). Do NOT call session_create; write into that session.`,
    "",
    "First call `session_get_instructions({topic:\"authoring\"})` and follow it, with these adjustments:",
    "- skip the file-lenses subagent step entirely",
    `- the code is at \`${scope.checkout.replace(/\\/g, "/")}\`${scope.isWorktree ? " (a detached snapshot; read files there with Read/Grep/Glob — no shell in this run)" : ""}; anchors stay repository-relative`,
    diffFile ? `- the full diff is already in the file \`${diffFile.replace(/\\/g, "/")}\`: Read it instead of running git` : `- get the diff with: \`${scope.diffCommand}\``,
    "- keep it compact: what/why, design with one diagram, implementation walk with code peeks on the mechanism; omit sections the change does not need",
    "- this document will be read by a code reviewer next: make the entry points, data flow and invariants explicit, and link every claim to lines",
    "",
    "Begin an activity, write incrementally, end the activity when done, then reply with one word: done.",
  ].join("\n");
}

export function buildExplainRun(
  scope: ResolvedScope,
  sessionId: string,
  deps: { sandboxDir: string; claudePath?: string; diffFile?: string; model?: string; whiteboardServer: Record<string, unknown> },
): RunOptions {
  const tools = ["Read", "Grep", "Glob", "mcp__whiteboard__*", ...(scope.isWorktree ? [] : ["Bash(git diff *)", "Bash(git show *)", "Bash(git log *)"])];
  return {
    prompt: buildExplainPrompt({ scope, sessionId, diffFile: deps.diffFile }),
    cwd: scope.isWorktree ? deps.sandboxDir : scope.checkout,
    addDirs: scope.isWorktree ? [scope.checkout] : undefined,
    allowedTools: tools,
    mcpServers: { whiteboard: deps.whiteboardServer },
    outputFormat: "stream-json",
    timeoutMs: EXPLAIN_TIMEOUT_MS,
    model: deps.model ?? REVIEW_MODEL,
    claudePath: deps.claudePath,
  };
}

export function buildDraftRun(
  review: Review,
  finding: Finding,
  excerpt: string,
  deps: { sandboxDir: string; claudePath?: string },
): RunOptions {
  // Same isolation as reviews: a snapshot of someone else's branch is never the working directory.
  const snapshot = Boolean(review.source?.worktree);
  return {
    prompt: buildDraftPrompt({ finding, review, excerpt }),
    cwd: snapshot ? deps.sandboxDir : review.repoRoot,
    addDirs: snapshot ? [review.repoRoot] : undefined,
    allowedTools: DRAFT_TOOLS,
    outputFormat: "json",
    timeoutMs: DRAFT_TIMEOUT_MS,
    model: DRAFT_MODEL,
    claudePath: deps.claudePath,
  };
}
