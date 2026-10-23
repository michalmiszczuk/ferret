// Proposal mode: a Claude session proposes a task as ordered edit steps; the user accepts, asks or declines each one
// in Ferret; the session applies what was accepted. Ferret never writes to the repo.
import { z } from "zod";

export const STEP_KINDS = ["edit", "create", "delete", "command"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_STATUSES = ["pending", "asked", "accepted", "applied", "declined", "revised", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const DECISION_KINDS = ["accept", "decline", "ask"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const MAX_STEPS = 50;
export const MAX_CODE = 20_000;
export const MAX_TEXT = 1_000;
export const MAX_NOTE = 4_000;
export const MAX_QUESTION = 2_000;

const stepId = z.string().min(1).max(40).regex(/^[\w.-]+$/, "stepId: letters, digits, . _ - only");

/** An inline explanation shown in the diff under the first `after` line that contains `at`. */
export const stepNoteSchema = z.object({
  at: z.string().min(1).max(200).describe("A distinctive part of one line of `after`, e.g. `export function selectTheme(`"),
  text: z.string().min(1).max(400).describe("One or two sentences: what this function/block does and why it is shaped this way"),
});
export type StepNote = z.infer<typeof stepNoteSchema>;
export const MAX_NOTES = 30;

export const proposedStepInputSchema = z
  .object({
    stepId,
    title: z.string().min(1).max(200),
    file: z.string().min(1).optional().describe("Repo-relative path, forward slashes"),
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
    kind: z.enum(STEP_KINDS),
    what: z.string().min(1).max(MAX_TEXT).describe("One or two sentences: what changes"),
    why: z.string().min(1).max(MAX_TEXT).describe("One or two sentences: why it is needed"),
    before: z.string().max(MAX_CODE).optional().describe("The exact current text that will be replaced (edit/delete)"),
    after: z.string().max(MAX_CODE).optional().describe("The full replacement text (edit/create)"),
    command: z.string().max(2000).optional().describe("For kind=command: the command to run, e.g. `npm test`"),
    dependsOn: z.array(stepId).max(20).optional().describe("Steps that must be applied before this one"),
    notes: z.array(stepNoteSchema).max(MAX_NOTES).optional().describe("Inline explanations for functions/blocks in `after`, shown in the diff at that line"),
  })
  .superRefine((s, ctx) => {
    const need = (field: "before" | "after" | "command" | "file") => {
      if (!s[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `step ${s.stepId}: kind ${s.kind} needs ${field}` });
    };
    if (s.kind === "edit") (need("file"), need("before"), need("after"));
    if (s.kind === "create") (need("file"), need("after"));
    if (s.kind === "delete") (need("file"), need("before"));
    if (s.kind === "command") need("command");
  });
export type ProposedStepInput = z.infer<typeof proposedStepInputSchema>;

export const threadEntrySchema = z.object({
  by: z.enum(["you", "claude"]),
  kind: z.enum(["ask", "answer", "decline", "note", "accept"]),
  text: z.string(),
  at: z.string(),
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

export const stepSchema = proposedStepInputSchema.innerType().extend({
  status: z.enum(STEP_STATUSES),
  thread: z.array(threadEntrySchema),
  revisions: z.array(z.object({ what: z.string(), why: z.string(), before: z.string().optional(), after: z.string().optional(), at: z.string() })),
  decision: z.object({ kind: z.enum(DECISION_KINDS), text: z.string().optional(), at: z.string(), taken: z.boolean() }).optional(),
  outcome: z.object({ kind: z.enum(["applied", "failed", "skipped"]), note: z.string().optional(), at: z.string() }).optional(),
});
export type Step = z.infer<typeof stepSchema>;

export const proposalTaskSchema = z.object({
  title: z.string().min(1).max(200),
  context: z.string().max(4000).optional().describe("A paragraph on the task: goal, constraints, the plan it comes from"),
  planRef: z.string().max(300).optional().describe("Where the plan/task lives, e.g. a file path or ticket"),
});

export const proposalSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  repoRoot: z.string(),
  sessionId: z.string().optional(),
  projectDir: z.string().optional(),
  task: proposalTaskSchema,
  status: z.enum(["active", "done"]),
  steps: z.array(stepSchema),
});
export type Proposal = z.infer<typeof proposalSchema>;

// ---- MCP tool input shapes (raw zod shapes, as submitReviewShape) ----

export const proposeChangesShape = {
  repoRoot: z.string().min(1).describe("Absolute path of the repo the steps apply to"),
  sessionId: z.string().optional().describe("This Claude session's id (${CLAUDE_SESSION_ID}) so decisions come back here"),
  projectDir: z.string().optional().describe("This session's folder (${CLAUDE_PROJECT_DIR})"),
  task: proposalTaskSchema,
  steps: z.array(proposedStepInputSchema).min(1).max(MAX_STEPS),
};
export type ProposeChangesInput = z.infer<z.ZodObject<typeof proposeChangesShape>>;

export const addStepsShape = {
  proposalId: z.string().min(1),
  steps: z.array(proposedStepInputSchema).min(1).max(MAX_STEPS),
  afterStepId: z.string().optional().describe("Insert after this step; omit to append"),
};

export const reviseStepShape = {
  proposalId: z.string().min(1),
  stepId,
  what: z.string().min(1).max(MAX_TEXT).optional(),
  why: z.string().min(1).max(MAX_TEXT).optional(),
  before: z.string().max(MAX_CODE).optional(),
  after: z.string().max(MAX_CODE).optional(),
  notes: z.array(stepNoteSchema).max(MAX_NOTES).optional(),
};

export const answerShape = {
  proposalId: z.string().min(1),
  stepId,
  answer: z.string().min(1).max(MAX_NOTE),
};

export const markStepShape = {
  proposalId: z.string().min(1),
  stepId,
  outcome: z.enum(["applied", "failed", "skipped"]),
  note: z.string().max(MAX_NOTE).optional().describe("What you changed, why it failed, or a command's output (trimmed)"),
};

export const decisionSchema = z.object({
  kind: z.enum(DECISION_KINDS),
  text: z.string().max(MAX_QUESTION).optional(),
});
export type Decision = z.infer<typeof decisionSchema>;

/** Terminal step states: the proposal is done when every step is in one of these. */
export const isSettled = (s: Step): boolean => s.status === "applied" || s.status === "declined" || s.status === "skipped";

export function proposalProgress(p: Proposal): { applied: number; total: number } {
  return { applied: p.steps.filter((s) => s.status === "applied").length, total: p.steps.length };
}

/** The slash command a decision becomes in the proposing session's chat. */
export function decisionCommand(proposalId: string, stepId: string, d: Decision): string {
  const text = d.text?.replace(/\s+/g, " ").trim();
  return `/apply-proposal ${proposalId} ${stepId} ${d.kind}${text ? ` ${text}` : ""}`;
}
export const acceptAllCommand = (proposalId: string): string => `/apply-proposal ${proposalId} accept-all`;
/** Several steps approved at once (queued with "Approve & next" or Ctrl/Shift-picked): one message for the batch. */
export const acceptStepsCommand = (proposalId: string, stepIds: string[]): string =>
  `/apply-proposal ${proposalId} accept-steps ${stepIds.join(",")}`;
