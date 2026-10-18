import type { ClaudeStatus, ReviewSummary } from "../../shared/api-types";
import { scopeLabel } from "../../shared/findings";
import { repoName } from "../../shared/paths";
import type { Review } from "../../shared/schema";
import logoUrl from "../logo.png";
import { ExportMenu } from "./ExportMenu";
import { SourceLabel } from "./SourceLabel";

interface Props {
  reviews: ReviewSummary[];
  review: Review | null;
  onSwitch(id: string): void;
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

export function Header({
  reviews, review, onSwitch, claude, connecting, onConnect, onDelete, onClearAll, onReview,
  onDraftAll, draftingAll, onCopyMarkdown, onSaveMarkdown, onSendClickUp, onImportFile,
}: Props) {
  return (
    <header className="header">
      <div className="header-title">
        <img className="logo" src={logoUrl} alt="" width={28} height={28} />
        <strong>Ferret</strong>
        {review && (
          <span className="muted scope-title" title={review.summary}>
            {review.source ? <SourceLabel source={review.source} /> : `${repoName(review.repoRoot)} · ${scopeLabel(review.scope)}`}
            {" · "}
            {review.findings.length} findings
            {review.imported && <span className="imported"> · imported{review.imported.by ? ` from ${review.imported.by}` : ""}</span>}
          </span>
        )}
      </div>
      <button className="btn fix review-btn" onClick={onReview}>
        Review ▶
      </button>
      {reviews.length > 0 && (
        <select aria-label="Switch review" value={review?.id ?? ""} onChange={(e) => onSwitch(e.target.value)}>
          {reviews.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} · {new Date(r.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
      )}
      {review && onDraftAll && (
        <button className="btn quiet" title="Draft a reply for every open finding" disabled={draftingAll} onClick={onDraftAll}>
          {draftingAll ? "Drafting…" : "Draft all"}
        </button>
      )}
      <ExportMenu
        hasReview={Boolean(review)}
        onCopyMarkdown={onCopyMarkdown}
        onSaveMarkdown={onSaveMarkdown}
        onSendClickUp={onSendClickUp}
        onImportFile={onImportFile}
      />
      {review && (
        <button className="btn quiet" title="Delete this review" onClick={onDelete}>
          Delete
        </button>
      )}
      {reviews.length > 1 && (
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
