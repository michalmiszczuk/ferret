import { useState, type ReactNode } from "react";
import type { ProposalSummary, StepView } from "../../shared/api-types";
import { proposalProgress, type StepStatus } from "../../shared/proposal";
import type { ProposalFull } from "../api";

interface Props {
  proposals: ProposalSummary[];
  proposal: ProposalFull | null;
  stepId: string | null;
  /** Ctrl = toggle in the approval queue, Shift = queue a range, plain = open. */
  onSelect(stepId: string, mods: { ctrl: boolean; shift: boolean }): void;
  /** Steps approved locally, not yet sent to the chat (stepId → comment). */
  queued: Map<string, string>;
  onOpen(proposalId: string): void;
  /** Rendered above the timeline (running jobs). */
  top?: ReactNode;
}

export const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "Pending",
  asked: "Asked",
  accepted: "Accepted · waiting for Claude",
  applied: "✅ Applied",
  declined: "✕ Declined",
  revised: "Revised",
  failed: "⚠ Failed",
  skipped: "⏭ Skipped",
};

/** Left pane in Proposals mode: the open proposal's steps as a timeline, done proposals folded below. */
export function ProposalPane({ proposals, proposal, stepId, onSelect, queued, onOpen, top }: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  const done = proposals.filter((p) => p.status === "done" && p.id !== proposal?.id);
  const progress = proposal ? proposalProgress(proposal) : null;
  return (
    <aside className="list">
      {top}
      {proposal && progress ? (
        <div className="ptask">
          <div className="ptask-title" title={proposal.task.context}>
            {proposal.task.title}
          </div>
          <div className="muted small">
            {progress.applied} / {progress.total} applied{proposal.status === "done" ? " · done" : ""}
            {proposal.task.planRef ? ` · ${proposal.task.planRef}` : ""}
          </div>
          <div className="ptask-progress" aria-hidden="true">
            <i style={{ width: `${progress.total ? (100 * progress.applied) / progress.total : 0}%` }} />
          </div>
        </div>
      ) : (
        <p className="empty muted">No proposals yet.</p>
      )}
      <div className="section-label">
        <span>Steps</span>
        <span className="pick-hint" title="Ctrl+click adds a step to the approvals, Shift+click a range; n = approve & next">
          {queued.size > 0 ? `${queued.size} to send` : "Ctrl/Shift-click to pick"}
        </span>
      </div>
      {proposal && (
        <ul>
          {proposal.steps.map((s, i) => (
            <Row key={s.stepId} s={s} n={i + 1} selected={s.stepId === stepId} queued={queued.has(s.stepId)} comment={queued.get(s.stepId)} onSelect={onSelect} />
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <>
          <button className="done-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen((o) => !o)}>
            {doneOpen ? "▾" : "▸"} Done proposals ({done.length})
          </button>
          {doneOpen && (
            <ul>
              {done.map((p) => (
                <li key={p.id}>
                  <button className="row prow st-applied" onClick={() => onOpen(p.id)}>
                    <span className="sdot" aria-hidden="true" />
                    <span className="row-main">
                      <span className="row-title">{p.title}</span>
                      <span className="row-loc">
                        {p.progress.applied} / {p.progress.total} applied · {new Date(p.createdAt).toLocaleDateString()}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

function Row({
  s, n, selected, queued, comment, onSelect,
}: { s: StepView; n: number; selected: boolean; queued: boolean; comment?: string; onSelect(id: string, mods: { ctrl: boolean; shift: boolean }): void }) {
  const loc = s.kind === "command" ? s.command : s.file ? `${s.file}${s.lineStart ? `:${s.lineStart}` : ""}` : "";
  return (
    <li>
      <button
        className={`row prow st-${s.status}${selected ? " selected" : ""}${queued ? " queued" : ""}`}
        data-testid="step-row"
        aria-current={selected ? true : undefined}
        aria-pressed={queued}
        title={queued ? `Approved, not sent yet${comment ? ` — “${comment}”` : ""} (Ctrl+click to remove)` : STATUS_LABEL[s.status]}
        onMouseDown={(e) => e.shiftKey && e.preventDefault() /* no text selection on Shift+click */}
        onClick={(e) => onSelect(s.stepId, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      >
        {queued ? <span className="qmark" aria-hidden="true">✓</span> : <span className="sdot" aria-hidden="true" />}
        <span className="row-main">
          <span className="row-title">
            <span className="sid">{n}</span>
            {s.title}
          </span>
          <span className="row-loc">{loc}</span>
        </span>
        {s.stale && <span className="mini stale">stale</span>}
        {s.blocked && !s.stale && <span className="mini blocked">after {s.blockedBy.join(", ")}</span>}
        {s.status === "asked" && <span className="mini asked">asked</span>}
        {queued && comment && <span className="mini qnote" title={comment}>✎ note</span>}
      </button>
    </li>
  );
}
