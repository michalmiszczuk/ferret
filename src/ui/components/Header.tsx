import type { ClaudeStatus, ReviewSummary } from "../../shared/api-types";
import { countBySeverity, scopeLabel, SEVERITY_ICON } from "../../shared/findings";
import { repoName } from "../../shared/paths";
import { SEVERITIES, type Review } from "../../shared/schema";

interface Props {
  reviews: ReviewSummary[];
  review: Review | null;
  pendingCount: number;
  onSwitch(id: string): void;
  onSend(): void;
  claude: ClaudeStatus | null; // null = this server has no Claude integration (hide the control)
  connecting: boolean;
  onConnect(): void;
}

export function ConnectButton({ connecting, onConnect }: { connecting: boolean; onConnect(): void }) {
  return (
    <button className="btn connect" disabled={connecting} onClick={onConnect}>
      {connecting ? "Connecting…" : "Connect Claude"}
    </button>
  );
}

export function Header({ reviews, review, pendingCount, onSwitch, onSend, claude, connecting, onConnect }: Props) {
  const counts = review ? countBySeverity(review.findings) : null;
  return (
    <header className="header">
      <div className="header-title">
        <strong>review-app</strong>
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
      {claude &&
        (claude.connected ? (
          <span className="claude-ok">✓ Claude connected</span>
        ) : (
          <ConnectButton connecting={connecting} onConnect={onConnect} />
        ))}
      <button className="send" disabled={pendingCount === 0} onClick={onSend}>
        Send {pendingCount} to Claude ▶
      </button>
    </header>
  );
}
