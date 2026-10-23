import { useEffect, useMemo, useState, type Ref } from "react";
import type { StepView } from "../../shared/api-types";
import { vscodeUrl } from "../../shared/paths";
import type { DecisionKind, ThreadEntry } from "../../shared/proposal";
import { fetchProposalFile, type ProposalFull } from "../api";
import { canAccept, canAsk, canDecline, canQueue } from "../useProposals";
import { DiffView, locate, type DiffContext } from "./DiffView";

type DiffMode = "full" | "changes";
const DIFF_MODE_KEY = "ferret.diffMode";
function savedDiffMode(): DiffMode {
  try {
    return localStorage.getItem(DIFF_MODE_KEY) === "changes" ? "changes" : "full";
  } catch {
    return "full";
  }
}

/**
 * The step's change, by default inside the whole current file (scrolled to the change), or only the change.
 * Full file needs the step's text in the file: `before` while pending, `after` once applied; otherwise it falls back.
 */
function StepDiff({ proposalId, step: s }: { proposalId: string; step: StepView }) {
  const [mode, setModeRaw] = useState<DiffMode>(savedDiffMode);
  const setMode = (m: DiffMode) => {
    setModeRaw(m);
    try {
      localStorage.setItem(DIFF_MODE_KEY, m);
    } catch {
      // per-session only
    }
  };
  const [content, setContent] = useState<string | null | undefined>(undefined); // undefined = loading, null = none
  const canFull = (s.kind === "edit" || s.kind === "delete") && Boolean(s.file);
  useEffect(() => {
    setContent(undefined);
    if (mode !== "full" || !canFull) return;
    let cancelled = false;
    fetchProposalFile(proposalId, s.file!)
      .then((f) => !cancelled && setContent(f.exists ? f.content : null))
      .catch(() => !cancelled && setContent(null));
    return () => {
      cancelled = true;
    };
  }, [proposalId, s.file, s.stepId, s.status, mode, canFull]);

  const context = useMemo<DiffContext | undefined>(() => {
    if (mode !== "full" || !content) return undefined;
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const hint = s.lineStart ?? 1;
    const at = (s.before && locate(lines, s.before, hint)) || (s.status === "applied" && s.after ? locate(lines, s.after, hint) : null);
    if (!at) return undefined;
    return { prefix: lines.slice(0, at.start), suffix: lines.slice(at.start + at.len), startLine: at.start + 1 };
  }, [mode, content, s.before, s.after, s.status, s.lineStart]);

  const fallback =
    mode === "full" && canFull && content !== undefined && !context
      ? content === null
        ? "The file isn't there, so only the change is shown."
        : "The change isn't in the file as written, so only the change is shown."
      : null;

  return (
    <>
      <div className="diff-bar">
        <div className="segmented" role="group" aria-label="Diff view">
          <button aria-pressed={mode === "full"} disabled={!canFull} title={canFull ? "The whole file with the change in place" : "New file: the change is the whole file"} onClick={() => setMode("full")}>
            Full file
          </button>
          <button aria-pressed={mode === "changes" || !canFull} onClick={() => setMode("changes")}>
            Changes only
          </button>
        </div>
        {mode === "full" && canFull && content === undefined && <span className="muted small">Loading the file…</span>}
        {fallback && <span className="muted small">{fallback}</span>}
      </div>
      <DiffView before={s.before} after={s.after} file={s.file} notes={s.notes} context={context} firstLine={s.lineStart ?? 1} />
    </>
  );
}
import { STATUS_LABEL } from "./ProposalPane";

interface Props {
  proposal: ProposalFull;
  step: StepView;
  index: number;
  busy: boolean;
  onDecide(kind: DecisionKind, text?: string): void;
  /** Ask Claude to re-read the file and revise this (stale) step. */
  onRefresh(): void;
  onAcceptAll(): void;
  remaining: number;
  askRef?: Ref<HTMLTextAreaElement>;
  /** The local approval queue (stepId → comment): approve without messaging the chat, send them all at once. */
  queued: Map<string, string>;
  onApproveNext(text: string): void;
  onSendQueued(): void;
  onClearQueue(): void;
}

const WHO: Record<ThreadEntry["kind"], string> = { ask: "You asked", answer: "Claude", decline: "You declined", note: "Claude", accept: "You accepted" };

export function StepCard({
  proposal, step: s, index, busy, onDecide, onRefresh, onAcceptAll, remaining, askRef, queued, onApproveNext, onSendQueued, onClearQueue,
}: Props) {
  const isQueued = queued.has(s.stepId);
  const canQueueThis = canQueue(s) && !busy;
  const [msg, setMsg] = useState("");
  // Re-opening an approved step shows the comment it was approved with, so it can be edited and approved again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setMsg(queued.get(s.stepId) ?? ""), [s.stepId]);
  const text = msg.trim();
  const accept = canAccept(s) && !busy;
  const decline = canDecline(s) && !busy;
  const ask = canAsk(s) && !busy && text.length > 0;
  const deps = s.dependsOn ?? [];
  const link = s.file ? vscodeUrl(proposal.repoRoot, s.file, s.lineStart ?? 1) : null;

  return (
    <div className="step-view">
      <div className="step-scroll">
      <div className={`scard st-${s.status}`} data-testid="step-card">
        <div className="scard-head">
          <span className="muted">
            Step {index + 1} of {proposal.steps.length} · <code className="sid">{s.stepId}</code>
          </span>
          <span className={`badge st-${s.status}`}>{STATUS_LABEL[s.status]}</span>
          {deps.length > 0 && (
            <span className={`mini ${s.blocked ? "blocked" : ""}`} title={s.blocked ? `Waits for ${s.blockedBy.join(", ")} to be applied` : "Dependencies applied"}>
              after {deps.join(", ")}
              {s.blocked ? " · blocked" : " ✓"}
            </span>
          )}
          {s.kind !== "edit" && <span className="mini blocked">{s.kind}</span>}
        </div>
        <h3 className="scard-title">{s.title}</h3>
        {s.file && (
          <div className="path">
            {link ? (
              <a href={link} title="Open in VS Code">
                {s.file}
                {s.lineStart ? `:${s.lineStart}${s.lineEnd && s.lineEnd !== s.lineStart ? `–${s.lineEnd}` : ""}` : ""}
              </a>
            ) : (
              s.file
            )}
          </div>
        )}
        <div className="whatwhy">
          <p>{s.what}</p>
          <p className="muted">{s.why}</p>
        </div>

        {s.stale && (
          <div className="stale-banner">
            <span>⚠ The file no longer contains this step's “before” text. Ask Claude to re-read it and revise the step.</span>
            <button className="btn small-btn" disabled={busy} onClick={onRefresh}>
              Ask Claude to refresh
            </button>
          </div>
        )}

        {s.kind === "command" ? <pre className="cmd">$ {s.command}</pre> : <StepDiff proposalId={proposal.id} step={s} />}

        {s.outcome?.note && (s.kind === "command" || s.status === "failed") && (
          // Command output / failure detail as a block; an applied edit's one-line note shows in the thread below.
          <details className="outcome" open>
            <summary>{s.kind === "command" ? "Output" : "What went wrong"}</summary>
            <pre>{s.outcome.note}</pre>
          </details>
        )}

        {s.revisions.length > 0 && (
          <details className="revs">
            <summary>
              v{s.revisions.length + 1} · {s.revisions.length} previous version{s.revisions.length > 1 ? "s" : ""}
            </summary>
            {s.revisions.map((r, i) => (
              <div key={i} className="rev">
                <div className="label">
                  v{i + 1} · {new Date(r.at).toLocaleString()}
                </div>
                <p>{r.what}</p>
                <p className="muted">{r.why}</p>
                {s.kind !== "command" && <DiffView before={r.before} after={r.after} file={s.file} />}
              </div>
            ))}
          </details>
        )}

        {s.thread.filter((t) => t.text).length > 0 && (
          <div className="thread">
            {s.thread
              .filter((t) => t.text)
              .map((t, i) => (
                <div key={i} className={`bubble ${t.by}`}>
                  <span className="who">
                    {WHO[t.kind]} · {new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {t.text}
                </div>
              ))}
          </div>
        )}
      </div>
      </div>
      {/* Pinned footer: the decision controls never scroll away under a long diff. */}
      <div className="step-foot">
        {s.status !== "applied" && (
          <>
            <label className="label" htmlFor={`ask-${s.stepId}`}>
              Comment for Claude (goes with Approve / Accept / Decline; Ask needs one)
            </label>
            <textarea
              id={`ask-${s.stepId}`}
              ref={askRef}
              rows={2}
              value={msg}
              placeholder="e.g. “remove the comment” then Approve & next (Claude applies it with that change) · or a question + Ctrl+Enter to Ask"
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ask) {
                  e.preventDefault();
                  onDecide("ask", msg);
                }
              }}
            />
          </>
        )}

        {queued.size > 0 && (
          <div className="queue-bar">
            <span>
              <strong>{queued.size}</strong> approved, not sent yet:{" "}
              {proposal.steps
                .filter((x) => queued.has(x.stepId))
                .map((x) => (queued.get(x.stepId) ? `${x.stepId} ✎` : x.stepId))
                .join(", ")}
            </span>
            <button className="btn fix" disabled={busy} title="One message to Claude for all of them" onClick={onSendQueued}>
              Send {queued.size} approval{queued.size === 1 ? "" : "s"} ▶
            </button>
            <button className="btn quiet" disabled={busy} title="Esc" onClick={onClearQueue}>
              Clear
            </button>
          </div>
        )}
        <div className="actions">
          {s.status !== "applied" && (
            <>
              <button
                className="btn approve-next"
                disabled={!canQueueThis}
                title={
                  s.stale
                    ? "Stale: refresh first"
                    : "Mark approved here (with the comment above, if any) and open the next step; nothing is sent to Claude yet (n)"
                }
                onClick={() => onApproveNext(msg)}
              >
                {isQueued ? (text !== (queued.get(s.stepId) ?? "") ? "Update approval & next ↓" : "✓ Approved · next ↓") : text ? "Approve with comment & next ↓" : "Approve & next ↓"}
              </button>
              <button className="btn" disabled={!accept} title={s.stale ? "Stale: refresh first" : s.blocked ? `Blocked by ${s.blockedBy.join(", ")}` : "Accept and send to Claude now (a)"} onClick={() => onDecide("accept", msg)}>
                Accept now ▶
              </button>
              <button className="btn" disabled={!ask} title="q focuses the box · Ctrl+Enter" onClick={() => onDecide("ask", msg)}>
                Ask
              </button>
              <button className="btn" disabled={!decline} title="d" onClick={() => onDecide("decline", msg)}>
                Decline
              </button>
            </>
          )}
          {remaining > 0 && (
            <button className="btn" disabled={busy} title="Accept every pending step that is not blocked (one message to Claude)" onClick={onAcceptAll}>
              Accept all remaining ({remaining})
            </button>
          )}
          {s.status === "accepted" && <span className="muted sent">Sent, waiting for Claude</span>}
          <span className="muted keys">n approve & next · a accept now · d decline · q ask · j/k move</span>
        </div>
      </div>
    </div>
  );
}
