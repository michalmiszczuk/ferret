// The portable review file: Markdown a human reads anywhere + a fenced JSON block another Ferret imports.
import { z } from "zod";
import { isSafeRevision, isSha, sourceLabel } from "./git-parse";
import { SEVERITY_LABEL, sortFindings } from "./findings";
import { findingSchema, reviewSourceSchema, scopeSchema, type Finding, type Review, type Severity } from "./schema";
import { SEVERITIES } from "./schema";

export const FORMAT_VERSION = 1;
export const FENCE = "```json ferret-review";

/** A review without anything tied to the exporter's machine. */
export const portableReviewSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  scope: scopeSchema,
  summary: z.string(),
  agent: z.literal("claude"),
  // A shared file is untrusted: the revisions it names are handed to git, so they must look like revisions.
  source: reviewSourceSchema
    .omit({ checkout: true, repo: true, worktree: true })
    .extend({
      head: z.string().refine(isSha, "head must be a commit hash"),
      base: z.string().refine(isSafeRevision, "base must be a revision").optional(),
      url: z.string().regex(/^https:\/\/[^\s]+$/, "url must be https").optional(),
    })
    .optional(),
  imported: z.object({ by: z.string().optional(), at: z.string() }).optional(),
  findings: z.array(findingSchema),
});
export type PortableReview = z.infer<typeof portableReviewSchema>;

export function toPortable(review: Review): PortableReview {
  const { repoRoot: _r, sessionId: _s, projectDir: _p, jobId: _j, source, ...rest } = review;
  let portableSource: PortableReview["source"];
  if (source) {
    const { checkout: _c, repo: _repo, worktree: _w, ...keep } = source;
    portableSource = keep;
  }
  return { ...rest, ...(portableSource ? { source: portableSource } : {}) };
}

const loc = (f: { file: string; lineStart: number; lineEnd: number }) =>
  `${f.file}:${f.lineStart}${f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}`;

function findingMd(f: Finding): string {
  const out: string[] = [`### ${f.title}`, "", `\`${loc(f)}\` · ${f.category}`, "", f.body.trim()];
  if (f.suggestion) out.push("", "**Suggestion**", "", f.suggestion.trim());
  if (f.steps?.length) {
    out.push("", `**Path** (${f.steps.length} places)`, "");
    f.steps.forEach((s, i) => out.push(`${i + 1}. \`${loc(s)}\` — ${s.note}`));
  }
  if (f.draft) out.push("", "**Reply**", "", f.draft.trim());
  if (f.resolution) out.push("", `**Claude:** ${f.resolution.trim()}`);
  return out.join("\n");
}

export function exportReview(review: Review, opts: { by?: string } = {}): string {
  const p = toPortable(review);
  const title = review.source ? sourceLabel(review.source) : review.scope.kind === "diff" ? "uncommitted changes" : review.scope.target.join(", ");
  const head: string[] = [`# Ferret review · ${title}`, ""];
  if (review.source?.url) head.push(`Pull request: ${review.source.url}  `);
  if (review.source) head.push(`Repository: ${review.source.repoName} · commit \`${review.source.head.slice(0, 12)}\`${review.source.base ? ` (base \`${review.source.base}\`)` : ""}  `);
  head.push(`Reviewed: ${review.createdAt.slice(0, 16).replace("T", " ")}${opts.by ? ` by ${opts.by}` : ""}`, "", review.summary.trim(), "");

  const active = sortFindings(review.findings.filter((f) => f.status !== "dismissed"));
  const dismissed = sortFindings(review.findings.filter((f) => f.status === "dismissed"));
  const counts = SEVERITIES.map((s) => `${SEVERITY_LABEL[s]} ${active.filter((f) => f.severity === s).length}`).join(" · ");
  const body: string[] = [`**Findings:** ${active.length} (${counts})`, ""];
  for (const sev of SEVERITIES as readonly Severity[]) {
    const group = active.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    body.push(`## ${SEVERITY_LABEL[sev]}`, "");
    for (const f of group) body.push(findingMd(f), "");
  }
  if (dismissed.length) {
    body.push("## Dismissed", "");
    for (const f of dismissed) body.push(`- ${f.title} (\`${loc(f)}\`)`);
    body.push("");
  }

  const block = [FENCE, JSON.stringify({ formatVersion: FORMAT_VERSION, review: p }, null, 2), "```"];
  return [...head, ...body, "---", "", "<!-- Ferret: import this file with “Import review…” to open it at the same commit -->", "", ...block, ""].join("\n");
}

export function parseExport(text: string): { ok: true; review: PortableReview; by?: string } | { ok: false; error: string } {
  let raw: unknown;
  const start = text.lastIndexOf(FENCE); // the block is last; a finding's body may quote the fence
  if (start >= 0) {
    const from = start + FENCE.length;
    const end = text.indexOf("\n```", from);
    const json = text.slice(from, end === -1 ? undefined : end).trim();
    try {
      raw = JSON.parse(json);
    } catch (err) {
      return { ok: false, error: `The ferret-review block is not valid JSON: ${(err as Error).message}` };
    }
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: "No ferret-review block found in this file" };
    }
  }
  const env = raw as { formatVersion?: unknown; review?: unknown };
  if (env.formatVersion !== FORMAT_VERSION) return { ok: false, error: `Unsupported format version ${String(env.formatVersion)} (this Ferret reads ${FORMAT_VERSION})` };
  const parsed = portableReviewSchema.safeParse(env.review);
  if (!parsed.success) return { ok: false, error: `Review data invalid: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  const by = text.match(/^Reviewed: .* by (.+)$/m)?.[1]?.trim();
  return { ok: true, review: parsed.data, by };
}
