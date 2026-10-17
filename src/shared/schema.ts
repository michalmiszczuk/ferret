import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export const CATEGORIES = ["bug", "security", "performance", "maintainability", "style", "other"] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof categorySchema>;

export const STATUSES = ["open", "fix_requested", "fixing", "fixed", "skipped", "dismissed"] as const;
export const statusSchema = z.enum(STATUSES);
export type FindingStatus = z.infer<typeof statusSchema>;

export const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("diff"), target: z.literal("uncommitted") }),
  z.object({ kind: z.literal("files"), target: z.array(z.string().min(1)).min(1) }),
]);
export type Scope = z.infer<typeof scopeSchema>;

/** One point on a finding's path (where the problem starts, flows through, bites). */
export const stepSchema = z
  .object({
    file: z.string().min(1).describe("Repo-relative path with forward slashes"),
    lineStart: z.number().int().min(1),
    lineEnd: z.number().int().min(1),
    snippet: z.string().min(1).describe("Exact code of lines lineStart..lineEnd"),
    note: z.string().min(1).max(300).describe("One line: what happens at this point"),
  })
  .refine((s) => s.lineEnd >= s.lineStart, { message: "lineEnd must be >= lineStart", path: ["lineEnd"] });
export type Step = z.infer<typeof stepSchema>;

export const findingInputSchema = z
  .object({
    severity: severitySchema.describe("critical | high | medium | low — see the severity rules in the ai-review skill"),
    title: z.string().min(1).max(200).describe("One line, shown in the findings list"),
    body: z.string().min(1).describe("Markdown: what is wrong, why it matters, a concrete failure scenario"),
    suggestion: z.string().optional().describe("Proposed fix, prose or code"),
    category: categorySchema,
    file: z.string().min(1).describe("Repo-relative path with forward slashes"),
    lineStart: z.number().int().min(1).describe("1-based, inclusive"),
    lineEnd: z.number().int().min(1).describe("1-based, inclusive, >= lineStart"),
    snippet: z.string().min(1).describe("Exact code of lines lineStart..lineEnd, copied from the file"),
    steps: z
      .array(stepSchema)
      .min(2)
      .max(10)
      .optional()
      .describe("Only when the problem spans several places: the ordered path (e.g. input enters → passes through → bites)"),
  })
  .refine((f) => f.lineEnd >= f.lineStart, { message: "lineEnd must be >= lineStart", path: ["lineEnd"] });
export type FindingInput = z.infer<typeof findingInputSchema>;

export const submitReviewShape = {
  repoRoot: z.string().min(1).describe("Absolute path of the repository root"),
  scope: scopeSchema,
  summary: z.string().min(1).describe("Short overall verdict"),
  findings: z.array(findingInputSchema),
  sessionId: z
    .string()
    .optional()
    .describe("The Claude Code session id (${CLAUDE_SESSION_ID}) so 'Send to Claude' can return to this conversation"),
  projectDir: z
    .string()
    .optional()
    .describe("The folder this Claude Code session runs in (${CLAUDE_PROJECT_DIR}) — the VS Code window to return to"),
};
export const submitReviewSchema = z.object(submitReviewShape);
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

export const findingSchema = z.object({
  id: z.string(),
  severity: severitySchema,
  originalSeverity: severitySchema,
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(),
  category: categorySchema,
  file: z.string(),
  lineStart: z.number().int(),
  lineEnd: z.number().int(),
  snippet: z.string(),
  steps: z
    .array(z.object({ file: z.string(), lineStart: z.number().int(), lineEnd: z.number().int(), snippet: z.string(), note: z.string() }))
    .optional(),
  status: statusSchema,
  myNote: z.string().optional(),
  resolution: z.string().optional(),
  updatedAt: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  repoRoot: z.string(),
  scope: scopeSchema,
  summary: z.string(),
  agent: z.literal("claude"),
  sessionId: z.string().optional(),
  projectDir: z.string().optional(),
  findings: z.array(findingSchema),
});
export type Review = z.infer<typeof reviewSchema>;

/** What the UI may change on a finding. Claude-only statuses (fixing/fixed/skipped) are excluded. */
export const findingPatchSchema = z
  .object({
    status: z.enum(["open", "fix_requested", "dismissed"]).optional(),
    severity: severitySchema.optional(),
    myNote: z.string().max(2000).optional(),
  })
  .strict();
export type FindingPatch = z.infer<typeof findingPatchSchema>;
