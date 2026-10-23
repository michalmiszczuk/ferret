// Proposal mode store: proposals and their steps, persisted one JSON file each under ~/.review-app/proposals.
// Mirrors ReviewStore (serialized atomic writes, `change` events). Ferret never touches the repo: the proposing
// Claude session applies accepted steps and reports back through markStep.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { StepView, StoreEvent } from "../shared/api-types";
import { normalizeFindingPath } from "../shared/paths";
import {
  isSettled,
  proposalSchema,
  type Decision,
  type Proposal,
  type ProposedStepInput,
  type ProposeChangesInput,
  type Step,
} from "../shared/proposal";
import { readRepoFile, reanchor } from "./files";
import { NotFoundError } from "./store";

export type StepPatch = Partial<Pick<Step, "what" | "why" | "before" | "after" | "notes">>;

/** The `readFile` for `views()`: reads a repo-relative file from the proposal's repo, null when missing or unreadable. */
export function repoFileReader(repoRoot: string): (rel: string) => Promise<string | null> {
  return async (rel) => {
    try {
      const f = await readRepoFile(repoRoot, rel);
      return f.exists ? f.content : null;
    } catch {
      return null;
    }
  };
}

function newProposalId(): string {
  return `p_${randomBytes(3).toString("hex")}`;
}

/** A new step: repo-relative forward-slash `file` (Claude often sends absolute paths), pending, empty history. */
function toStep(input: ProposedStepInput, repoRoot: string): Step {
  let file = input.file;
  if (file) {
    try {
      file = normalizeFindingPath(file, repoRoot);
    } catch (err) {
      throw new Error(`step ${input.stepId}: ${(err as Error).message}`);
    }
  }
  return { ...input, ...(file ? { file } : {}), status: "pending", thread: [], revisions: [] };
}

/** Rejects duplicate step ids (within the new steps and against existing ones), dependsOn ids that name no step,
 *  and dependency cycles (a step waiting on itself could never be applied). */
function validateSteps(existing: Step[], added: ProposedStepInput[]): void {
  const ids = new Set(existing.map((s) => s.stepId));
  for (const s of added) {
    if (ids.has(s.stepId)) throw new Error(`step ${s.stepId}: stepId is used twice in this proposal`);
    ids.add(s.stepId);
  }
  const deps = new Map<string, string[]>([...existing, ...added].map((s) => [s.stepId, s.dependsOn ?? []]));
  for (const s of added) {
    for (const dep of s.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`step ${s.stepId}: dependsOn ${dep} is not a step of this proposal`);
      if (dep === s.stepId) throw new Error(`step ${s.stepId}: dependsOn must not name the step itself`);
    }
  }
  // Cycle check: walk from every new step; reaching it again means a loop.
  for (const s of added) {
    const seen = new Set<string>();
    const stack = [...(s.dependsOn ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === s.stepId) throw new Error(`step ${s.stepId}: dependsOn forms a cycle`);
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(deps.get(id) ?? []));
    }
  }
}

export class ProposalStore extends EventEmitter {
  private proposals = new Map<string, Proposal>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly log: (msg: string) => void = console.warn,
  ) {
    super();
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(this.dir, name);
      try {
        const proposal = proposalSchema.parse(JSON.parse(await fs.readFile(full, "utf8")));
        this.proposals.set(proposal.id, proposal);
      } catch (err) {
        this.log(`review-app: skipping unreadable proposal file ${full}: ${(err as Error).message}`);
      }
    }
  }

  list(): Proposal[] {
    return [...this.proposals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  latest(): Proposal | undefined {
    return this.list()[0];
  }

  async create(input: ProposeChangesInput): Promise<Proposal> {
    validateSteps([], input.steps);
    const now = new Date().toISOString();
    let id = newProposalId();
    while (this.proposals.has(id)) id = newProposalId();
    const proposal: Proposal = {
      id,
      createdAt: now,
      updatedAt: now,
      repoRoot: input.repoRoot,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.projectDir ? { projectDir: input.projectDir } : {}),
      task: input.task,
      status: "active",
      steps: input.steps.map((s) => toStep(s, input.repoRoot)),
    };
    this.proposals.set(id, proposal);
    await this.save(proposal, "proposal-created");
    return proposal;
  }

  async addSteps(id: string, steps: ProposedStepInput[], afterStepId?: string): Promise<Proposal> {
    const proposal = this.require(id);
    validateSteps(proposal.steps, steps);
    const added = steps.map((s) => toStep(s, proposal.repoRoot));
    if (afterStepId) {
      const at = proposal.steps.findIndex((s) => s.stepId === afterStepId);
      if (at === -1) throw new NotFoundError(`Step ${afterStepId} not found in proposal ${id}`);
      proposal.steps.splice(at + 1, 0, ...added);
    } else {
      proposal.steps.push(...added);
    }
    proposal.status = "active";
    await this.save(proposal, "proposal-updated");
    return proposal;
  }

  /** Claude reworked a step after a question or a decline: the old text is kept, the step is pending again. */
  async reviseStep(id: string, stepId: string, patch: StepPatch): Promise<Step> {
    const proposal = this.require(id);
    const step = this.requireStep(proposal, stepId);
    if (step.status === "applied") throw new Error(`Step ${stepId} is already applied`);
    const now = new Date().toISOString();
    step.revisions.push({ what: step.what, why: step.why, before: step.before, after: step.after, at: now });
    for (const key of ["what", "why", "before", "after", "notes"] as const) {
      if (patch[key] !== undefined) (step as Record<typeof key, unknown>)[key] = patch[key];
    }
    step.status = "pending";
    delete step.decision;
    proposal.status = "active";
    await this.save(proposal, "proposal-updated");
    return step;
  }

  async answer(id: string, stepId: string, answer: string): Promise<Step> {
    const proposal = this.require(id);
    const step = this.requireStep(proposal, stepId);
    const now = new Date().toISOString();
    step.thread.push({ by: "claude", kind: "answer", text: answer, at: now });
    if (step.status === "asked") {
      step.status = "pending";
      delete step.decision;
    }
    await this.save(proposal, "proposal-updated");
    return step;
  }

  async decide(id: string, stepId: string, d: Decision): Promise<Step> {
    const proposal = this.require(id);
    const step = this.requireStep(proposal, stepId);
    if (step.status === "applied") throw new Error(`Step ${stepId} is already applied`);
    const blockedBy = this.blockedBy(proposal, step);
    if (blockedBy.length && d.kind === "accept") {
      throw new Error(`Step ${stepId} waits for ${blockedBy.join(", ")} to be applied first`);
    }
    this.applyDecision(step, d);
    proposal.status = "active";
    await this.save(proposal, "proposal-updated");
    return step;
  }

  /** Accepts every pending step that is not blocked. Staleness is the UI's warning, not checked here. */
  async acceptAllRemaining(id: string): Promise<Step[]> {
    const proposal = this.require(id);
    const accepted: Step[] = [];
    for (const step of proposal.steps) {
      if (step.status !== "pending") continue;
      if (this.blockedBy(proposal, step).length) continue;
      this.applyDecision(step, { kind: "accept" });
      accepted.push(step);
    }
    if (accepted.length) await this.save(proposal, "proposal-updated");
    return accepted;
  }

  /**
   * Accepts a batch of steps in proposal order. A step's prerequisites must be applied, already accepted, or accepted
   * earlier in this same batch (the session applies decisions in order). Stale steps and steps that are not open
   * (applied, accepted) are skipped with a reason.
   */
  async acceptSteps(
    id: string,
    stepIds: string[],
    stale: Set<string> = new Set(),
    /** Per-step comment ("accept but remove the comment"), delivered with the decision. */
    texts: Record<string, string> = {},
  ): Promise<{ accepted: Step[]; skipped: { stepId: string; reason: string }[] }> {
    const proposal = this.require(id);
    const want = new Set(stepIds);
    for (const sid of want) this.requireStep(proposal, sid);
    const byId = new Map(proposal.steps.map((s) => [s.stepId, s]));
    const inBatch = new Set<string>();
    const accepted: Step[] = [];
    const skipped: { stepId: string; reason: string }[] = [];
    const open = new Set(["pending", "asked", "revised", "declined", "failed"]);
    for (const step of proposal.steps) {
      if (!want.has(step.stepId)) continue;
      if (!open.has(step.status)) {
        skipped.push({ stepId: step.stepId, reason: `already ${step.status}` });
        continue;
      }
      if (stale.has(step.stepId)) {
        skipped.push({ stepId: step.stepId, reason: "stale (the file changed)" });
        continue;
      }
      const waiting = (step.dependsOn ?? []).filter((d) => {
        const st = byId.get(d)?.status;
        return st !== "applied" && st !== "accepted" && !inBatch.has(d);
      });
      if (waiting.length) {
        skipped.push({ stepId: step.stepId, reason: `waits for ${waiting.join(", ")}` });
        continue;
      }
      this.applyDecision(step, { kind: "accept", text: texts[step.stepId] });
      inBatch.add(step.stepId);
      accepted.push(step);
    }
    if (accepted.length) {
      proposal.status = "active";
      await this.save(proposal, "proposal-updated");
    }
    return { accepted, skipped };
  }

  /** Hands out decisions not yet delivered to the session (mirrors ReviewStore.takePending). */
  async takeDecisions(id?: string): Promise<{ proposal: Proposal; steps: Step[] }> {
    const proposal = id ? this.require(id) : this.latest();
    if (!proposal) throw new NotFoundError("No proposals yet. Run /propose-changes first.");
    const steps = proposal.steps.filter((s) => s.decision && !s.decision.taken);
    if (steps.length) {
      for (const s of steps) s.decision!.taken = true;
      await this.save(proposal, "proposal-updated");
    }
    return { proposal, steps };
  }

  async markStep(id: string, stepId: string, outcome: "applied" | "failed" | "skipped", note?: string): Promise<Step> {
    const proposal = this.require(id);
    const step = this.requireStep(proposal, stepId);
    const now = new Date().toISOString();
    step.status = outcome;
    step.outcome = { kind: outcome, ...(note ? { note } : {}), at: now };
    if (note) step.thread.push({ by: "claude", kind: "note", text: note, at: now });
    proposal.status = proposal.steps.every(isSettled) ? "done" : "active";
    await this.save(proposal, "proposal-updated");
    return step;
  }

  async delete(id: string): Promise<void> {
    this.require(id);
    this.proposals.delete(id);
    const file = path.join(this.dir, `${id}.json`);
    const remove = () => fs.rm(file, { force: true });
    const p = this.writeQueue.then(remove, remove);
    this.writeQueue = p.catch(() => {});
    await p;
    this.emitChange({ type: "proposal-deleted", proposalId: id });
  }

  /** Steps as the UI shows them: stale when the file no longer holds `before`, blocked when a dependency is not applied. */
  async views(proposal: Proposal, readFile: (rel: string) => Promise<string | null>): Promise<StepView[]> {
    const contents = new Map<string, string | null>();
    const read = async (rel: string): Promise<string | null> => {
      if (!contents.has(rel)) {
        let content: string | null = null;
        try {
          content = await readFile(rel);
        } catch {
          content = null;
        }
        contents.set(rel, content);
      }
      return contents.get(rel) ?? null;
    };
    const out: StepView[] = [];
    for (const step of proposal.steps) {
      const blockedBy = this.blockedBy(proposal, step);
      let stale = false;
      const checkable = (step.kind === "edit" || step.kind === "delete") && step.file && step.before !== undefined;
      const open = step.status === "pending" || step.status === "asked" || step.status === "revised";
      if (checkable && open) {
        const content = await read(step.file!);
        if (content === null) stale = true;
        else {
          const lineStart = step.lineStart ?? 1;
          const lineEnd = step.lineEnd ?? lineStart;
          stale = reanchor(content, { lineStart, lineEnd, snippet: step.before! }).anchor === "lost";
        }
      }
      out.push({ ...step, stale, blocked: blockedBy.length > 0, blockedBy });
    }
    return out;
  }

  private blockedBy(proposal: Proposal, step: Step): string[] {
    const byId = new Map(proposal.steps.map((s) => [s.stepId, s]));
    return (step.dependsOn ?? []).filter((dep) => byId.get(dep)?.status !== "applied");
  }

  private applyDecision(step: Step, d: Decision): void {
    const now = new Date().toISOString();
    const text = d.text?.trim();
    step.status = d.kind === "accept" ? "accepted" : d.kind === "decline" ? "declined" : "asked";
    step.decision = { kind: d.kind, ...(text ? { text } : {}), at: now, taken: false };
    const entryKind = d.kind === "accept" ? "accept" : d.kind === "decline" ? "decline" : "ask";
    if (text || d.kind !== "accept") step.thread.push({ by: "you", kind: entryKind, text: text ?? "", at: now });
  }

  private require(id: string): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new NotFoundError(`Proposal ${id} not found`);
    return proposal;
  }

  private requireStep(proposal: Proposal, stepId: string): Step {
    const step = proposal.steps.find((s) => s.stepId === stepId);
    if (!step) throw new NotFoundError(`Step ${stepId} not found in proposal ${proposal.id}`);
    return step;
  }

  private async save(proposal: Proposal, type: "proposal-created" | "proposal-updated"): Promise<void> {
    proposal.updatedAt = new Date().toISOString();
    await this.persist(proposal);
    this.emitChange({ type, proposalId: proposal.id });
  }

  private emitChange(e: StoreEvent): void {
    this.emit("change", e);
  }

  /** Writes are serialized and atomic (tmp file + rename) so a crash never leaves half a JSON file. */
  private persist(proposal: Proposal): Promise<void> {
    const data = JSON.stringify(proposal, null, 2);
    const file = path.join(this.dir, `${proposal.id}.json`);
    const write = async () => {
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, data, "utf8");
      await fs.rename(tmp, file);
    };
    const p = this.writeQueue.then(write, write);
    this.writeQueue = p.catch(() => {});
    return p;
  }
}
