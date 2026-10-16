import { listView, SEVERITY_ICON, SEVERITY_LABEL, type Filters, type StatusFilter } from "../../shared/findings";
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

const STATUS_BADGE: Record<FindingStatus, string> = {
  open: "",
  fix_requested: "Fix ✓",
  fixing: "Fixing…",
  fixed: "✅ Fixed",
  skipped: "⏭ Skipped",
  dismissed: "✕ Dismissed",
};

export function FindingsList(p: Props) {
  const { active, done } = listView(p.findings, p.filters);
  const showDone = p.doneOpen || p.filters.status === "done";

  const toggleSeverity = (s: Severity) => {
    const has = p.filters.severities.includes(s);
    p.onFiltersChange({
      ...p.filters,
      severities: has ? p.filters.severities.filter((x) => x !== s) : SEVERITIES.filter((x) => x === s || p.filters.severities.includes(x)),
    });
  };

  return (
    <aside className="list">
      <div className="filters">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            className={`chip sev-${s}`}
            aria-pressed={p.filters.severities.includes(s)}
            onClick={() => toggleSeverity(s)}
          >
            {SEVERITY_ICON[s]} {SEVERITY_LABEL[s]}
          </button>
        ))}
        <select
          aria-label="Status filter"
          value={p.filters.status}
          onChange={(e) => p.onFiltersChange({ ...p.filters, status: e.target.value as StatusFilter })}
        >
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </select>
      </div>

      {active.length === 0 && done.length === 0 && <p className="empty muted">No findings match the filters.</p>}

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
