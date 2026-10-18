import { useEffect, useState, type Ref } from "react";
import Markdown from "react-markdown";
import type { Anchor } from "../../shared/api-types";
import { SEVERITY_LABEL } from "../../shared/findings";
import { Gem } from "./Gem";
import { PathSteps } from "./PathSteps";
import { SEVERITIES, type Finding, type FindingPatch, type Severity } from "../../shared/schema";

interface Props {
  finding: Finding;
  anchor: Anchor["anchor"] | "missing";
  onUpdate(patch: FindingPatch): void;
  /** Send this finding to Claude with the user's message (empty = "just fix it"). */
  onSend(message: string): void;
  /** Jump to a step of the finding's path (multi-place findings only). */
  onStep?(i: number): void;
  /** Ask Claude to draft a reply for the author (headless). Absent = this build can't. */
  onDraft?(): void;
  drafting?: boolean;
  /** Shown when the review's code is a snapshot (PR / older commit). */
  snapshotHint?: string;
  /** Replaces the message box text when it changes (e.g. "Ask about this step"). */
  presetMessage?: { text: string; n: number };
  noteRef?: Ref<HTMLTextAreaElement>;
}

export function CommentCard({ finding: f, anchor, onUpdate, onSend, onStep, onDraft, drafting, snapshotHint, presetMessage, noteRef }: Props) {
  const [note, setNote] = useState(f.myNote ?? "");
  useEffect(() => setNote(f.myNote ?? ""), [f.id, f.myNote]);
  useEffect(() => {
    if (presetMessage) setNote(presetMessage.text);
  }, [presetMessage]);
  const [draft, setDraft] = useState(f.draft ?? "");
  useEffect(() => setDraft(f.draft ?? ""), [f.id, f.draft]);
  const [copied, setCopied] = useState(false);
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // the textarea is selectable; nothing else to do
    }
  };

  const actionable = f.status === "open" || f.status === "fix_requested";
  const resettable = f.status === "fixing" || f.status === "skipped" || f.status === "dismissed";
  const noteId = `note-${f.id}`;
  const sevId = `sev-${f.id}`;

  return (
    <div className={`card sev-${f.severity}`} data-testid="comment-card">
      <div className="card-head">
        <span className={`sev-label sev-${f.severity}`}>
          <Gem severity={f.severity} /> {SEVERITY_LABEL[f.severity].toUpperCase()}
        </span>
        <span className="muted"> · {f.category}</span>
        {f.severity !== f.originalSeverity && (
          <span className="muted"> (Claude said {SEVERITY_LABEL[f.originalSeverity]})</span>
        )}
      </div>
      <h3 className="card-title">{f.title}</h3>

      {anchor === "lost" && <p className="warn">⚠ code changed since review. Original snippet:</p>}
      {anchor === "missing" && <p className="warn">⚠ file no longer exists. Original snippet:</p>}
      {(anchor === "lost" || anchor === "missing") && <pre className="snippet">{f.snippet}</pre>}

      <div className="md">
        <Markdown>{f.body}</Markdown>
      </div>

      {onStep && <PathSteps finding={f} active={null} onStep={onStep} />}

      {f.suggestion && (
        <div className="suggestion">
          <div className="label">Suggestion</div>
          <div className="md">
            <Markdown>{f.suggestion}</Markdown>
          </div>
        </div>
      )}

      {f.resolution && (
        <div className="resolution">
          <div className="label">Claude</div>
          <p>{f.resolution}</p>
        </div>
      )}

      {(onDraft || f.draft) && (
        <div className="draft">
          <div className="label-row">
            <label className="label" htmlFor={`draft-${f.id}`}>
              Reply to author
            </label>
            {onDraft && (
              <button className="btn small-btn" disabled={drafting} onClick={onDraft}>
                {drafting ? "Drafting…" : f.draft ? "Regenerate" : "Draft reply"}
              </button>
            )}
            {f.draft && (
              <button className="btn small-btn" onClick={copyDraft}>
                {copied ? "Copied ✓" : "Copy"}
              </button>
            )}
          </div>
          {f.draft ? (
            <textarea
              id={`draft-${f.id}`}
              rows={4}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft !== (f.draft ?? "")) onUpdate({ draft });
              }}
            />
          ) : (
            <p className="muted small">Let Claude write a short comment you can paste to the PR author.</p>
          )}
        </div>
      )}

      {snapshotHint && <p className="snapshot-hint muted small">{snapshotHint}</p>}

      <label className="label" htmlFor={noteId}>
        Message to Claude
      </label>
      <textarea
        id={noteId}
        ref={noteRef}
        rows={2}
        value={note}
        placeholder="Tell Claude what to do, e.g. “fix it but keep the public API” or “is this really a problem?”. Empty = just fix it."
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== (f.myNote ?? "")) onUpdate({ myNote: note });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && actionable) {
            e.preventDefault();
            onSend(note);
          }
        }}
      />

      <div className="actions">
        {actionable && (
          <button className="btn fix" title="Ctrl+Enter" onClick={() => onSend(note)}>
            {f.status === "fix_requested" ? "Send again ▶" : "Send to Claude ▶"}
          </button>
        )}
        {f.status === "fix_requested" && <span className="muted sent">Sent, waiting for Claude</span>}
        {actionable && (
          <button className="btn" onClick={() => onUpdate({ status: "dismissed" })}>
            Dismiss
          </button>
        )}
        {resettable && (
          <button className="btn" onClick={() => onUpdate({ status: "open" })}>
            Reset to open
          </button>
        )}
        <span className="sev-select">
          <label htmlFor={sevId}>Severity</label>
          <select id={sevId} value={f.severity} onChange={(e) => onUpdate({ severity: e.target.value as Severity })}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </span>
      </div>
    </div>
  );
}
