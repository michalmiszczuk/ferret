import type { ClaudeStatus, ReviewSummary } from "../../shared/api-types";
import { countBySeverity, scopeLabel, SEVERITY_ICON } from "../../shared/findings";
import { repoName } from "../../shared/paths";
import { SEVERITIES, type Review } from "../../shared/schema";
import logoUrl from "../logo.png";

interface Props {
  reviews: ReviewSummary[];
  review: Review | null;
  onSwitch(id: string): void;
  claude: ClaudeStatus | null; // null = this server has no Claude integration (hide the control)
  connecting: boolean;
  onConnect(): void;
  onDelete(): void;
  onClearAll(): void;
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
  reviews, review, onSwitch, claude, connecting, onConnect, onDelete, onClearAll,
}: Props) {
  const counts = review ? countBySeverity(review.findings) : null;
  return (
    <header className="header">
      <div className="header-title">
        <img className="logo" src={logoUrl} alt="" width={20} height={20} />
        <strong>Ferret</strong>
        {review && (
          <span className="muted" title={review.summary}>
            {repoName(review.repoRoot)} · {scopeLabel(review.scope)} · {review.findings.length} findings
          </span>
        )}
      </div>
      {counts && (
        <div className="counts">
          {SEVERITIES.map((s) => (
            <span key={s} className={`count sev-${s}`}>
              {SEVERITY_ICON[s]} {counts[s]}
            </span>
          ))}
        </div>
      )}
      {reviews.length > 0 && (
        <select aria-label="Switch review" value={review?.id ?? ""} onChange={(e) => onSwitch(e.target.value)}>
          {reviews.map((r) => (
            <option key={r.id} value={r.id}>
              {r.repoName} · {scopeLabel(r.scope)} · {new Date(r.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
      )}
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
