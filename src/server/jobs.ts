// Background jobs: headless reviews (one at a time) and reply drafts (own lane). Persists a short history.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Job as WireJob } from "../shared/api-types";

/** The server's view of a job: `scope` is typed. */
export type Job = Omit<WireJob, "scope"> & { scope?: ScopeInput };
import type { Finding, Review } from "../shared/schema";
import { runClaude as defaultRunClaude, type RunHandle, type RunOptions } from "./claude-runner";
import { readRepoFile, reanchor, splitLines } from "./files";
import { buildDraftRun, buildExplainRun, buildReviewRun, REVIEW_MODEL } from "./prompts";
import {
  diffPatch,
  resolveScope as defaultResolveScope,
  sweepWorktrees,
  type PrInfoFn,
  type ResolvedScope,
  type ScopeInput,
} from "./scope";
import { NotFoundError, type ReviewStore } from "./store";
import type { WhiteboardService } from "./whiteboard";
import { formatTaskContext, parseTaskRef, type ClickUpService } from "./clickup";
import type { Review as StoredReview } from "../shared/schema";

/** Read through a function so TypeScript doesn't narrow `job.status` after an assignment above. */
const isCancelled = (job: Job): boolean => job.status === "cancelled";

export interface JobManagerDeps {
  store: ReviewStore;
  home: string;
  mcpUrl: string;
  rules: string;
  runner?: (o: RunOptions) => RunHandle;
  resolveScope?: typeof defaultResolveScope;
  prInfo?: PrInfoFn;
  claudePath?: string;
  log?: (msg: string) => void;
  /** Whiteboard: explain-first pass and drawing the finished review, when the job asked for it. */
  whiteboard?: WhiteboardService;
  /** ClickUp: the task a change implements, read for the reviewer when the job names one. */
  clickup?: Pick<ClickUpService, "taskContext">;
}

const HISTORY = 100;
const ACTIVITY_LINES = 6;
const SCOPE_TTL_MS = 60 * 60 * 1000;
const id = (p: string) => `${p}_${randomBytes(3).toString("hex")}`;

export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private order: string[] = []; // creation order, oldest first
  private handles = new Map<string, RunHandle>();
  private aborts = new Map<string, AbortController>(); // cancels git work (fetch, worktree add) before claude starts
  private reviewLaneBusy = false;
  private draftLaneBusy = false;
  private submitted = new Map<string, string>(); // jobId → reviewId
  private scopes = new Map<string, { scope: ResolvedScope; expires: number }>();
  private jobScopes = new Map<string, ResolvedScope>();
  private jobTasks = new Map<string, NonNullable<StoredReview["task"]>>();
  private readonly file: string;
  readonly worktreesDir: string;
  readonly sandboxDir: string;

  constructor(private readonly deps: JobManagerDeps & { mcpUrl: string }) {
    super();
    this.file = path.join(deps.home, "jobs.json");
    this.worktreesDir = path.join(deps.home, "worktrees");
    this.sandboxDir = path.join(deps.home, "sandbox");
  }

  /** The server learns its real port after listen(); update the URL headless Claude is given. */
  setMcpUrl(url: string): void {
    this.deps.mcpUrl = url;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.sandboxDir, { recursive: true });
    try {
      const list = JSON.parse(await fs.readFile(this.file, "utf8")) as Job[];
      for (const j of list) {
        if (j.status === "running" || j.status === "queued") {
          j.status = "cancelled";
          j.endedAt = new Date().toISOString();
          j.error = "Ferret was closed while this job was running.";
        }
        this.jobs.set(j.id, j);
        this.order.push(j.id);
      }
    } catch {
      // no history yet
    }
  }

  list(): Job[] {
    return this.order.map((i) => this.jobs.get(i)!).reverse();
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  // ---- scopes shared with the chat skill ----

  registerScope(scope: ResolvedScope): string {
    const scopeId = id("s");
    this.scopes.set(scopeId, { scope, expires: Date.now() + SCOPE_TTL_MS });
    for (const [k, v] of this.scopes) if (v.expires < Date.now()) this.scopes.delete(k);
    return scopeId;
  }

  takeScope(scopeId: string): ResolvedScope | undefined {
    const e = this.scopes.get(scopeId);
    if (!e || e.expires < Date.now()) return undefined;
    this.scopes.delete(scopeId);
    return e.scope;
  }

  scopeForJob(jobId: string): ResolvedScope | undefined {
    return this.jobScopes.get(jobId);
  }

  /** The ClickUp task a review job was started with (attached to the review on submit). */
  taskForJob(jobId: string): StoredReview["task"] {
    return this.jobTasks.get(jobId);
  }

  /** Checkouts something may still be reading: running review jobs and chat scopes not yet submitted. */
  private activeCheckouts(): string[] {
    const out: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "running" && job.status !== "queued") continue;
      const s = this.jobScopes.get(job.id);
      if (s) out.push(s.checkout);
    }
    for (const e of this.scopes.values()) if (e.expires >= Date.now()) out.push(e.scope.checkout);
    return out;
  }

  /**
   * Removes Ferret worktrees no review points at (and nothing is reading). Called at startup and after a review is
   * deleted. Returns the removed paths; never throws.
   */
  async sweepWorktrees(): Promise<string[]> {
    const keep = [
      ...this.deps.store.list().flatMap((r) => (r.source?.worktree ? [r.source.checkout] : [])),
      ...this.activeCheckouts(),
    ];
    try {
      const removed = await sweepWorktrees(this.worktreesDir, keep);
      if (removed.length) this.deps.log?.(`Ferret: removed ${removed.length} unused worktree${removed.length === 1 ? "" : "s"}`);
      return removed;
    } catch (err) {
      this.deps.log?.(`Ferret: worktree sweep failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Called by submit_review when Claude links a review to a job. */
  reviewSubmitted(jobId: string, reviewId: string): void {
    this.submitted.set(jobId, reviewId);
    const job = this.jobs.get(jobId);
    if (job) {
      job.reviewId = reviewId;
      this.touch(job);
    }
  }

  // ---- starting jobs ----

  startReview(input: ScopeInput, model?: string, opts: { whiteboard?: Job["whiteboard"]; task?: string; notes?: string } = {}): Job {
    const job = this.add({
      kind: "review",
      label: labelFor(input),
      scope: input,
      model: model ?? REVIEW_MODEL,
      whiteboard: opts.whiteboard || undefined,
      task: opts.task || undefined,
      notes: opts.notes?.trim() || undefined,
    });
    void this.pumpReviews();
    return job;
  }

  startDraft(reviewId: string, findingId: string): Job {
    const review = this.requireReview(reviewId);
    const finding = review.findings.find((f) => f.id === findingId);
    if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);
    const job = this.add({ kind: "draft", label: `Draft reply: ${finding.title}`, reviewId, findingId });
    void this.pumpDrafts();
    return job;
  }

  startDraftAll(reviewId: string, redo = false): Job {
    this.requireReview(reviewId);
    const job = this.add({ kind: "draft-all", label: redo ? "Redo all replies" : "Draft all replies", reviewId, note: redo ? "redo" : undefined });
    void this.pumpDrafts();
    return job;
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError(`Job ${jobId} not found`);
    if (job.status === "queued") return this.finish(job, "cancelled");
    if (job.status === "running") {
      job.status = "cancelled"; // the runner's close handler sees cancelled and keeps it
      this.aborts.get(jobId)?.abort();
      this.handles.get(jobId)?.cancel();
      this.touch(job);
    }
  }

  /** App quitting: kill every running claude/git process and wait briefly so nothing outlives Ferret. */
  async shutdown(): Promise<void> {
    const live = [...this.jobs.values()].filter((j) => j.status === "running" || j.status === "queued");
    const waits: Promise<unknown>[] = [];
    for (const job of live) {
      const handle = this.handles.get(job.id);
      if (handle) waits.push(handle.done);
      await this.cancel(job.id);
      job.error = "Ferret was closed while this job was running.";
    }
    await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 5000))]);
    await this.persistQueue;
  }

  // ---- internals ----

  private add(partial: Pick<Job, "kind" | "label"> & Partial<Job>): Job {
    const job: Job = { id: id("j"), status: "queued", createdAt: new Date().toISOString(), logTail: [], ...partial };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    while (this.order.length > HISTORY) {
      const old = this.order.shift()!;
      const j = this.jobs.get(old);
      if (j && (j.status === "running" || j.status === "queued")) this.order.unshift(old); // never drop live jobs
      else this.jobs.delete(old);
      if (this.order[0] === old) break;
    }
    this.touch(job);
    return job;
  }

  private requireReview(reviewId: string): Review {
    const review = this.deps.store.get(reviewId);
    if (!review) throw new NotFoundError(`Review ${reviewId} not found`);
    return review;
  }

  private nextQueued(kinds: Job["kind"][]): Job | undefined {
    for (const i of this.order) {
      const j = this.jobs.get(i);
      if (j && j.status === "queued" && kinds.includes(j.kind)) return j;
    }
    return undefined;
  }

  private async pumpReviews(): Promise<void> {
    if (this.reviewLaneBusy) return;
    const job = this.nextQueued(["review"]);
    if (!job) return;
    this.reviewLaneBusy = true;
    try {
      await this.runReview(job);
    } finally {
      this.reviewLaneBusy = false;
      void this.pumpReviews();
    }
  }

  private async pumpDrafts(): Promise<void> {
    if (this.draftLaneBusy) return;
    const job = this.nextQueued(["draft", "draft-all"]);
    if (!job) return;
    this.draftLaneBusy = true;
    try {
      if (job.kind === "draft") await this.runDraft(job);
      else await this.runDraftAll(job);
    } finally {
      this.draftLaneBusy = false;
      void this.pumpDrafts();
    }
  }

  private async runReview(job: Job): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.phase = job.scope?.type === "pr" ? "Fetching the pull request" : "Preparing";
    job.progress = job.scope?.type === "pr" ? "git fetch origin pull/…" : "Resolving the scope";
    job.activity = [];
    job.stats = { tools: 0, files: 0 };
    this.touch(job);
    let scope: ResolvedScope;
    const abort = new AbortController();
    this.aborts.set(job.id, abort);
    try {
      scope = await (this.deps.resolveScope ?? defaultResolveScope)(job.scope!, {
        worktreesDir: this.worktreesDir,
        prInfo: this.deps.prInfo,
        signal: abort.signal,
      });
    } catch (err) {
      if (isCancelled(job)) return this.finish(job, "cancelled");
      return this.finish(job, "failed", (err as Error).message);
    } finally {
      this.aborts.delete(job.id);
    }
    if (isCancelled(job)) return this.finish(job, "cancelled");
    this.jobScopes.set(job.id, scope);
    job.label = scope.label;
    const before = this.deps.store.findBySourceHead(scope.source.repo, scope.source.head);
    if (before) job.note = `Reviewed before: ${before.id} (same commit)`;
    job.phase = `Reviewing ${scope.changedFiles.length} changed file${scope.changedFiles.length === 1 ? "" : "s"}`;
    job.progress = scope.isWorktree ? "Snapshot ready, starting Claude" : "Starting Claude";
    this.touch(job);

    // Snapshot runs have no shell (a PR branch is untrusted), so the diff is written for Claude to Read.
    let diffFile: string | undefined;
    if (scope.isWorktree) {
      diffFile = path.join(this.sandboxDir, `${job.id}.diff`);
      try {
        await fs.writeFile(diffFile, await diffPatch(scope.checkout, scope.diffArgs), "utf8");
      } catch (err) {
        return this.finish(job, "failed", `Could not produce the diff: ${(err as Error).message}`);
      }
    }
    // The ClickUp task the change implements: its description and comments become the reviewer's requirements.
    let taskText: string | undefined;
    if (job.task && this.deps.clickup) {
      job.phase = "Reading the ClickUp task";
      job.progress = job.task;
      this.touch(job);
      try {
        const ref = parseTaskRef(job.task);
        if (!ref) throw new Error("not a task link or id");
        const t = await this.deps.clickup.taskContext(ref);
        taskText = formatTaskContext(t);
        job.taskName = t.name;
        this.jobTasks.set(job.id, { id: t.id, name: t.name, url: t.url });
      } catch (err) {
        job.note = `ClickUp task: ${(err as Error).message.slice(0, 160)}`;
      }
      job.phase = `Reviewing ${scope.changedFiles.length} changed file${scope.changedFiles.length === 1 ? "" : "s"}`;
      this.touch(job);
    }

    // "Explain first": Claude writes the Whiteboard document for the change, and the review reads it as its map.
    let wbSessionId: string | undefined;
    let context: string | undefined;
    const wb = this.deps.whiteboard;
    if (job.whiteboard === "explain" && wb) {
      job.phase = "Explaining on Whiteboard";
      job.progress = "Looking for an existing Whiteboard of this change";
      this.touch(job);
      try {
        const target = { source: scope.source, repoRoot: scope.checkout, scopeKind: "files" as const };
        wbSessionId = await wb.findExisting(target);
        if (wbSessionId) {
          job.progress = "Reusing the Whiteboard that already exists for this change";
          this.touch(job);
        } else {
          const server = await wb.mcpServer();
          if (!server) throw new Error("Whiteboard isn't connected to Claude Code");
          wbSessionId = await wb.createSession(target, scope.label, true);
          job.progress = "Claude is drawing the explanation";
          this.touch(job);
          const explain = await this.execute(
            job,
            buildExplainRun(scope, wbSessionId, {
              sandboxDir: this.sandboxDir,
              claudePath: this.deps.claudePath,
              diffFile,
              model: job.model,
              whiteboardServer: server,
              task: [job.notes ? `Notes from the requester:\n${job.notes}` : "", taskText ?? ""].filter(Boolean).join("\n\n") || undefined,
            }),
          );
          if (isCancelled(job) || explain.cancelled) {
            if (diffFile) await fs.rm(diffFile, { force: true }).catch(() => {});
            return this.finish(job, "cancelled");
          }
          if (!explain.ok) job.note = `Whiteboard explanation did not finish: ${(explain.resultText || explain.logTail[explain.logTail.length - 1] || "").slice(0, 160)}`;
        }
        job.progress = "Reading the explanation back";
        this.touch(job);
        context = await wb.readOutline(wbSessionId);
      } catch (err) {
        job.note = `Whiteboard: ${(err as Error).message.slice(0, 200)}`;
      }
      job.phase = `Reviewing ${scope.changedFiles.length} changed file${scope.changedFiles.length === 1 ? "" : "s"}`;
      job.progress = context ? "Starting Claude with the explanation as its map" : "Starting Claude";
      this.touch(job);
    }

    const run = buildReviewRun(scope, job.id, {
      rules: this.deps.rules,
      mcpUrl: this.deps.mcpUrl,
      sandboxDir: this.sandboxDir,
      claudePath: this.deps.claudePath,
      diffFile,
      model: job.model,
      context,
      task: taskText,
      notes: job.notes,
    });
    let result;
    try {
      result = await this.execute(job, run);
    } finally {
      if (diffFile) await fs.rm(diffFile, { force: true }).catch(() => {});
    }
    if (result.timedOut && !isCancelled(job)) return this.finish(job, "failed", "Review timed out after 15 minutes.");
    if (isCancelled(job) || result.cancelled) return this.finish(job, "cancelled");
    if (!result.ok) {
      // Prefer Claude's own words (the result text of an error result) over a raw log line.
      const reason =
        (result.isError && result.resultText.trim()) ||
        result.logTail.filter((l) => !l.startsWith("{")).find((l) => /error|fail/i.test(l)) ||
        result.logTail[result.logTail.length - 1] ||
        "claude exited with an error";
      return this.finish(job, "failed", `Review failed: ${reason.slice(0, 300)}`);
    }
    if (!this.submitted.has(job.id)) {
      // Claude finished without submitting: keep the run visible as an empty review.
      const review = await this.deps.store.create(
        {
          repoRoot: scope.checkout,
          scope: { kind: "files", target: scope.changedFiles.length ? scope.changedFiles : ["."] },
          summary: result.resultText.trim() || "Claude found nothing to report.",
          findings: [],
        },
        { source: scope.source, jobId: job.id, task: this.jobTasks.get(job.id) },
      );
      job.reviewId = review.id;
      job.note = "Claude found nothing to report.";
    }
    if (job.whiteboard && job.reviewId && wb) {
      job.phase = "Drawing on Whiteboard";
      job.progress = wbSessionId ? "Adding the findings to the Whiteboard" : "Creating the Whiteboard review";
      this.touch(job);
      try {
        const review = this.requireReview(job.reviewId);
        const { sessionId } = await wb.publish(review, wbSessionId);
        await this.deps.store.setWhiteboard(review.id, { sessionId, at: new Date().toISOString() });
      } catch (err) {
        job.note = `${job.note ? `${job.note} ` : ""}Whiteboard: ${(err as Error).message}`;
      }
    }
    this.finish(job, "done");
  }

  private async runDraft(job: Job): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.progress = "Drafting…";
    this.touch(job);
    try {
      const review = this.requireReview(job.reviewId!);
      const finding = review.findings.find((f) => f.id === job.findingId);
      if (!finding) throw new NotFoundError(`Finding ${job.findingId} not found`);
      const ok = await this.draftOne(job, review, finding);
      this.finish(job, ok ? "done" : isCancelled(job) ? "cancelled" : "failed", ok ? undefined : job.error ?? "Draft failed");
    } catch (err) {
      this.finish(job, "failed", (err as Error).message);
    }
  }

  private async runDraftAll(job: Job): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.touch(job);
    const redo = job.note === "redo";
    job.note = undefined;
    const review = this.requireReview(job.reviewId!);
    const targets = review.findings.filter((f) => f.status === "open" && (redo || !f.draft));
    let ok = 0;
    let failed = 0;
    for (const [i, f] of targets.entries()) {
      if (isCancelled(job)) return this.finish(job, "cancelled");
      job.progress = `Drafting ${i + 1} of ${targets.length}: ${f.title}`;
      this.touch(job);
      if (await this.draftOne(job, review, f)) ok++;
      else failed++;
    }
    if (isCancelled(job)) return this.finish(job, "cancelled");
    const drafted = `${ok} repl${ok === 1 ? "y" : "ies"} drafted`;
    if (failed) return this.finish(job, "failed", `${drafted}, ${failed} failed. ${job.error ?? ""}`.trim());
    job.note = drafted;
    this.finish(job, "done");
  }

  /** Runs one draft; stores it on the finding. Returns false on failure (job.error set). */
  private async draftOne(job: Job, review: Review, finding: Finding): Promise<boolean> {
    const excerpt = await this.excerpt(review, finding);
    const result = await this.execute(job, buildDraftRun(review, finding, excerpt, { sandboxDir: this.sandboxDir, claudePath: this.deps.claudePath }));
    if (!result.ok) {
      job.error = result.timedOut
        ? "Draft timed out after 2 minutes."
        : result.cancelled
          ? undefined
          : `Draft failed: ${(result.isError && result.resultText.trim()) || result.logTail[result.logTail.length - 1] || "claude exited with an error"}`;
      return false;
    }
    const text = result.resultText.trim();
    if (!text) {
      job.error = "Claude returned an empty draft";
      return false;
    }
    await this.deps.store.updateFinding(review.id, finding.id, { draft: text });
    return true;
  }

  private async excerpt(review: Review, f: Finding): Promise<string> {
    try {
      const file = await readRepoFile(review.repoRoot, f.file);
      if (!file.exists) return f.snippet;
      const a = reanchor(file.content, f);
      const lines = splitLines(file.content);
      const from = Math.max(0, a.lineStart - 11);
      const to = Math.min(lines.length, a.lineEnd + 10);
      return lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(4)}  ${l}`).join("\n");
    } catch {
      return f.snippet;
    }
  }

  private async execute(job: Job, run: RunOptions) {
    const handle = (this.deps.runner ?? defaultRunClaude)(run);
    this.handles.set(job.id, handle);
    const seenFiles = new Set<string>();
    handle.on("progress", (p: string) => {
      if (job.kind !== "review") return;
      job.progress = p;
      job.activity = [...(job.activity ?? []), p].slice(-ACTIVITY_LINES);
      const stats = (job.stats ??= { tools: 0, files: 0 });
      if (/^(Reading|Running|Searching|Submitting|mcp__)/.test(p) || /^[A-Z][A-Za-z]+$/.test(p)) stats.tools++;
      if (p.startsWith("Reading ")) {
        seenFiles.add(p.slice("Reading ".length));
        stats.files = seenFiles.size;
      }
      if (p.startsWith("Submitting")) job.phase = "Submitting findings";
      this.touchLive(job);
    });
    handle.on("log", (l: string) => {
      job.logTail.push(l);
      if (job.logTail.length > 60) job.logTail.shift();
    });
    try {
      return await handle.done;
    } finally {
      this.handles.delete(job.id);
    }
  }

  private finish(job: Job, status: Job["status"], error?: string): void {
    job.status = status;
    job.endedAt = new Date().toISOString();
    job.progress = undefined;
    if (error) job.error = error;
    this.touch(job);
  }

  private touch(job: Job): void {
    this.emit("change", { type: "job-updated", jobId: job.id });
    void this.persist();
  }

  /** For the activity stream: the UI hears every event, the history file is written at most every 2 s. */
  private persistTimer?: NodeJS.Timeout;
  private touchLive(job: Job): void {
    this.emit("change", { type: "job-updated", jobId: job.id });
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 2000);
  }

  private persistQueue: Promise<void> = Promise.resolve();
  private persist(): Promise<void> {
    const data = JSON.stringify(this.list().slice(0, HISTORY).reverse(), null, 2);
    const write = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(`${this.file}.tmp`, data, "utf8");
      await fs.rename(`${this.file}.tmp`, this.file);
    };
    const p = this.persistQueue.then(write, write).catch((e) => this.deps.log?.(`jobs.json write failed: ${(e as Error).message}`));
    this.persistQueue = p;
    return p;
  }
}

function labelFor(input: ScopeInput): string {
  switch (input.type) {
    case "changes":
      return "uncommitted changes";
    case "commit":
      return `commit ${input.sha.slice(0, 7)}`;
    case "range":
      return `${input.from}..${input.to}`;
    case "branch":
      return `${input.branch} vs ${input.base ?? "default branch"}`;
    case "pr":
      return `PR #${input.number}`;
  }
}
