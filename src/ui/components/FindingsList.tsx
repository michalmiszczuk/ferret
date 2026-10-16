import { listView, SEVERITY_LABEL, type Filters, type StatusFilter } from "../../shared/findings";
import { Gem } from "./Gem";
import { SEVERITIES, type Finding, type FindingStatus, type Severity } from "../../shared/schema";

interface Props {
  findings: Finding[];
  filters: Filters;
  onFiltersChange(f: Filters): void;
  selectedId: string | null;
  onSelect(id: string): void;
  doneOpen: boolean;
  onToggleDone(): void;
}

const STATUS_OPTIONS: [StatusFilter, string][] = [
  ["all", "All"],
  ["open", "Open"],
  ["done", "Done"],
];

const STATUS_BADGE: Record<FindingStatus, string> = {
  open: "",
  fix_requested: "Sent ✓",
  fixing: "Fixing…",
  fixed: "✅ Fixed",
  skipped: "⏭ Skipped",
  dismissed: "✕ Dismissed",
};

export function FindingsList(p: Props) {
  const { active, done } = listView(p.findings, p.filters);
  const showDone = p.doneOpen || p.filters.status === "done";

  // No chip selected = show all. Each click turns one severity on/off; turning the last one off shows all again.
  const showingAll = p.filters.severities.length === SEVERITIES.length;
  const toggleSeverity = (s: Severity) => {
    const current = showingAll ? [] : p.filters.severities;
    let next = current.includes(s) ? current.filter((x) => x !== s) : SEVERITIES.filter((x) => x === s || current.includes(x));
    if (next.length === 0) next = [...SEVERITIES];
    p.onFiltersChange({ ...p.filters, severities: next });
  };

  return (
    <aside className="list">
      <div className="filters">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            className={`chip sev-${s}`}
            aria-pressed={!showingAll && p.filters.severities.includes(s)}
            data-dim={!showingAll && !p.filters.severities.includes(s) ? "" : undefined}
            title="Click to show/hide this severity"
            onClick={() => toggleSeverity(s)}
          >
            <Gem severity={s} /> {SEVERITY_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="section-label">
        <span>Findings</span>
        <div className="segmented" role="group" aria-label="Status filter">
          {STATUS_OPTIONS.map(([value, label]) => (
            <button
              key={value}
              aria-pressed={p.filters.status === value}
              onClick={() => p.onFiltersChange({ ...p.filters, status: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {p.findings.length === 0 ? (
        <p className="empty muted">No findings yet.</p>
      ) : (
        active.length === 0 && done.length === 0 && <p className="empty muted">No findings match the filters.</p>
      )}

      <ul>
        {active.map((f) => (
          <Row key={f.id} f={f} selected={f.id === p.selectedId} onSelect={p.onSelect} />
        ))}
      </ul>

      {done.length > 0 && (
        <>
          <button className="done-toggle" aria-expanded={showDone} onClick={p.onToggleDone}>
            {showDone ? "▾" : "▸"} Done ({done.length})
          </button>
          {showDone && (
            <ul>
              {done.map((f) => (
                <Row key={f.id} f={f} selected={f.id === p.selectedId} onSelect={p.onSelect} />
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

function Row({ f, selected, onSelect }: { f: Finding; selected: boolean; onSelect(id: string): void }) {
  const badge = STATUS_BADGE[f.status];
  return (
    <li>
      <button
        className={`row sev-${f.severity}${selected ? " selected" : ""}`}
        data-testid="finding-row"
        aria-current={selected ? true : undefined}
        onClick={() => onSelect(f.id)}
      >
        <span className="sev-bar" aria-hidden="true" />
        <span className="row-main">
          <span className="row-title">{f.title}</span>
          <span className="row-loc">
            {f.file}:{f.lineStart}
          </span>
        </span>
        {badge && <span className={`badge status-${f.status}`}>{badge}</span>}
      </button>
    </li>
  );
}
