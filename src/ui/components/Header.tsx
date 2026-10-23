import type { ClaudeStatus, ProposalSummary, ReviewSummary } from "../../shared/api-types";
import { scopeLabel } from "../../shared/findings";
import { repoName } from "../../shared/paths";
import { proposalProgress } from "../../shared/proposal";
import type { Review } from "../../shared/schema";
import type { ProposalFull } from "../api";
import logoUrl from "../logo.png";
import type { Mode } from "../useProposals";
import { ExportMenu } from "./ExportMenu";
import { SourceLabel } from "./SourceLabel";

interface Props {
  mode: Mode;
  onMode(m: Mode): void;
  reviews: ReviewSummary[];
  review: Review | null;
  onSwitch(id: string): void;
  proposals: ProposalSummary[];
  proposal: ProposalFull | null;
  onSwitchProposal(id: string): void;
  onDeleteProposal(): void;
  claude: ClaudeStatus | null; // null = this server has no Claude integration (hide the control)
  connecting: boolean;
  onConnect(): void;
  onDelete(): void;
  onClearAll(): void;
  onReview(): void;
  /** Draft replies for every open finding (shown for reviews started from Ferret / with a source). */
  onDraftAll?(): void;
  draftingAll?: boolean;
  onCopyMarkdown(): void;
  onSaveMarkdown(): void;
  onSendClickUp(): void;
  onWhiteboard?(redraw: boolean): void;
  onImportFile(file: File): void;
}

export function ConnectButton({
  connecting, onConnect, update = false,
}: { connecting: boolean; onConnect(): void; update?: boolean }) {
  return (
    <button
      className="btn connect"
      disabled={connecting}
      onClick={onConnect}
      title={update ? "Your installed /ai-review and /apply-review skills are older than this app" : undefined}
    >
      {connecting ? "Connecting…" : update ? "Update Claude" : "Connect Claude"}
    </button>
  );
}

const MODES: [Mode, string][] = [
  ["reviews", "Reviews"],
  ["proposals", "Proposals"],
];

export function Header({
  mode, onMode, reviews, review, onSwitch, proposals, proposal, onSwitchProposal, onDeleteProposal,
  claude, connecting, onConnect, onDelete, onClearAll, onReview,
  onDraftAll, draftingAll, onCopyMarkdown, onSaveMarkdown, onSendClickUp, onWhiteboard, onImportFile,
}: Props) {
  const inReviews = mode === "reviews";
  const progress = proposal ? proposalProgress(proposal) : null;
  return (
    <header className="header">
      <div className="header-title">
        <img className="logo" src={logoUrl} alt="" width={28} height={28} />
        <strong>Ferret</strong>
        {inReviews && review && (
          <span className="muted scope-title" title={review.summary}>
            {review.source ? <SourceLabel source={review.source} /> : `${repoName(review.repoRoot)} · ${scopeLabel(review.scope)}`}
            {" · "}
            {review.findings.length} findings
            {review.imported && <span className="imported"> · imported{review.imported.by ? ` from ${review.imported.by}` : ""}</span>}
          </span>
        )}
        {!inReviews && proposal && progress && (
          <span className="muted scope-title" title={proposal.task.context}>
            {repoName(proposal.repoRoot)} · {proposal.task.title} · {progress.applied} / {progress.total} applied
          </span>
        )}
      </div>
      <div className="segmented" role="group" aria-label="Mode">
        {MODES.map(([m, label]) => (
          <button key={m} aria-pressed={mode === m} onClick={() => onMode(m)}>
            {label}
            {m === "proposals" && proposals.some((p) => p.status === "active") ? ` · ${proposals.filter((p) => p.status === "active").length}` : ""}
          </button>
        ))}
      </div>
      {inReviews && (
        <button className="btn fix review-btn" onClick={onReview}>
          Review ▶
        </button>
      )}
      {inReviews && reviews.length > 0 && (
        <select aria-label="Switch review" value={review?.id ?? ""} onChange={(e) => onSwitch(e.target.value)}>
          {reviews.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} · {new Date(r.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
      )}
      {!inReviews && proposals.length > 0 && (
        <select aria-label="Switch proposal" value={proposal?.id ?? ""} onChange={(e) => onSwitchProposal(e.target.value)}>
          {proposals.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} · {p.progress.applied}/{p.progress.total}{p.status === "done" ? " · done" : ""} · {new Date(p.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
      )}
      {inReviews && review && onDraftAll && (
        <button className="btn quiet" title="Draft a reply for every open finding" disabled={draftingAll} onClick={onDraftAll}>
          {draftingAll ? "Drafting…" : "Draft all"}
        </button>
      )}
      {inReviews && (
        <ExportMenu
          hasReview={Boolean(review)}
          onCopyMarkdown={onCopyMarkdown}
          onSaveMarkdown={onSaveMarkdown}
          onSendClickUp={onSendClickUp}
          onWhiteboard={onWhiteboard}
          whiteboardDrawn={Boolean(review?.whiteboard)}
          onImportFile={onImportFile}
        />
      )}
      {inReviews && review && (
        <button className="btn quiet" title="Delete this review" onClick={onDelete}>
          Delete
        </button>
      )}
      {!inReviews && proposal && (
        <button className="btn quiet" title="Delete this proposal" onClick={onDeleteProposal}>
          Delete
        </button>
      )}
      {inReviews && reviews.length > 1 && (
        <button className="btn quiet" title="Delete all reviews" onClick={onClearAll}>
          Clear all
        </button>
      )}
      {claude &&
        (claude.connected ? (
          <span className="claude-ok">✓ Claude connected</span>
        ) : (
          <ConnectButton
            connecting={connecting}
            onConnect={onConnect}
            update={claude.skillsInstalled && claude.mcpRegistered && Boolean(claude.skillsOutdated)}
          />
        ))}
    </header>
  );
}
