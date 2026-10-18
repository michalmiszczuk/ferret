import type { Finding } from "../../shared/schema";
import { PathSteps } from "./PathSteps";

interface Props {
  finding: Finding;
  index: number;
  lost: boolean;
  onStep(i: number | null): void;
  /** Pre-fills "Message to Claude" with a question about this step. */
  onAsk?(i: number): void;
}

/** Shown under the lines of one step of a finding's path: what happens here + navigation. */
export function StepBubble({ finding, index, lost, onStep, onAsk }: Props) {
  const steps = finding.steps ?? [];
  const step = steps[index];
  if (!step) return null;
  return (
    <div className={`card step-card sev-${finding.severity}`}>
      <div className="card-head">
        <span className="step-badge">{index + 1}</span>
        <span className="muted">
          Step {index + 1} of {steps.length} · {finding.title}
        </span>
      </div>
      <p className="step-note">{step.note}</p>
      {lost && (
        <>
          <p className="warn">⚠ code changed since review. Original snippet:</p>
          <pre className="snippet">{step.snippet}</pre>
        </>
      )}
      <PathSteps finding={finding} active={index} onStep={onStep} />
      <div className="actions">
        <button className="btn" disabled={index === 0} onClick={() => onStep(index - 1)}>
          ← Prev
        </button>
        <button className="btn" disabled={index === steps.length - 1} onClick={() => onStep(index + 1)}>
          Next →
        </button>
        {onAsk && (
          <button className="btn" onClick={() => onAsk(index)}>
            Ask about this step
          </button>
        )}
        <button className="btn quiet-back" onClick={() => onStep(null)}>
          Back to finding
        </button>
        <span className="muted keys">[ and ] move between steps</span>
      </div>
    </div>
  );
}
