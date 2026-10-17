import type { Finding } from "../../shared/schema";

/** The numbered path ① ② ③ … of a multi-place finding; click a step to jump to it. */
export function PathSteps({
  finding, active, onStep,
}: { finding: Finding; active: number | null; onStep(i: number): void }) {
  const steps = finding.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <div className="trail">
      <div className="label">Path · {steps.length} places</div>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>
            <button
              className={`trail-step sev-${finding.severity}${i === active ? " on" : ""}`}
              onClick={() => onStep(i)}
              title={`${s.file}:${s.lineStart}`}
            >
              <span className="step-badge">{i + 1}</span>
              <span className="trail-text">
                <span className="trail-note">{s.note}</span>
                <span className="trail-loc">
                  {s.file.split("/").pop()}:{s.lineStart}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
