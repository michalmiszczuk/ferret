import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { StoreEvent } from "../shared/api-types";
import { sortFindings } from "../shared/findings";
import { normalizeFindingPath } from "../shared/paths";
import { reviewSchema, type Finding, type Review, type SubmitReviewInput } from "../shared/schema";

export class NotFoundError extends Error {}

export type FindingUpdate = Partial<Pick<Finding, "status" | "severity" | "myNote" | "resolution">>;

function newReviewId(): string {
  return `r_${randomBytes(3).toString("hex")}`;
}

export class ReviewStore extends EventEmitter {
  private reviews = new Map<string, Review>();
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
        const review = reviewSchema.parse(JSON.parse(await fs.readFile(full, "utf8")));
        this.reviews.set(review.id, review);
      } catch (err) {
        this.log(`review-app: skipping unreadable review file ${full}: ${(err as Error).message}`);
      }
    }
  }

  list(): Review[] {
    return [...this.reviews.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Review | undefined {
    return this.reviews.get(id);
  }

  latest(): Review | undefined {
    return this.list()[0];
  }

  async create(input: SubmitReviewInput): Promise<Review> {
    const now = new Date().toISOString();
    const findings: Finding[] = input.findings.map((f, i) => ({
      ...f,
      file: normalizeFindingPath(f.file, input.repoRoot),
      id: `f${i + 1}`,
      originalSeverity: f.severity,
      status: "open",
      updatedAt: now,
    }));
    let id = newReviewId();
    while (this.reviews.has(id)) id = newReviewId();
    const review: Review = {
      id,
      createdAt: now,
      repoRoot: input.repoRoot,
      scope: input.scope,
      summary: input.summary,
      agent: "claude",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      findings,
    };
    this.reviews.set(review.id, review);
    await this.persist(review);
    this.emitChange({ type: "review-created", reviewId: review.id });
    return review;
  }

  async updateFinding(reviewId: string, findingId: string, patch: FindingUpdate): Promise<Finding> {
    const review = this.requireReview(reviewId);
    const finding = review.findings.find((f) => f.id === findingId);
    if (!finding) throw new NotFoundError(`Finding ${findingId} not found in review ${reviewId}`);
    Object.assign(finding, patch, { updatedAt: new Date().toISOString() });
    await this.persist(review);
    this.emitChange({ type: "review-updated", reviewId });
    return finding;
  }

  async takePending(reviewId?: string): Promise<{ review: Review; findings: Finding[] }> {
    const review = reviewId ? this.requireReview(reviewId) : this.latest();
    if (!review) throw new NotFoundError("No reviews yet. Run /ai-review first.");
    const pending = sortFindings(review.findings.filter((f) => f.status === "fix_requested"));
    if (pending.length > 0) {
      const now = new Date().toISOString();
      for (const f of pending) {
        f.status = "fixing";
        f.updatedAt = now;
      }
      await this.persist(review);
      this.emitChange({ type: "review-updated", reviewId: review.id });
    }
    return { review, findings: pending };
  }

  countFixing(reviewId: string): number {
    return this.requireReview(reviewId).findings.filter((f) => f.status === "fixing").length;
  }

  private requireReview(id: string): Review {
    const review = this.reviews.get(id);
    if (!review) throw new NotFoundError(`Review ${id} not found`);
    return review;
  }

  private emitChange(e: StoreEvent): void {
    this.emit("change", e);
  }

  /** Writes are serialized and atomic (tmp file + rename) so a crash never leaves half a JSON file. */
  private persist(review: Review): Promise<void> {
    const data = JSON.stringify(review, null, 2);
    const file = path.join(this.dir, `${review.id}.json`);
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
