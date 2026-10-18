import { useEffect, useState } from "react";
import type { Job } from "../../shared/api-types";
import { modelLabel } from "../../shared/models";
import { FerretDigger } from "./FerretDigger";

interface Props {
  job: Job;
  queuedAhead: number;
  onCancel(id: string): void;
  onOpenReview(reviewId: string): void;
  onDismiss(id: string): void;
}

function elapsed(from?: string, to?: string): string {
  if (!from) return "";
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One background job (review or draft) shown above the findings list. */
export function JobCard({ job, queuedAhead, onCancel, onOpenReview, onDismiss }: Props) {
  const [, tick] = useState(0);
  const live = job.status === "running" || job.status === "queued";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  // A running review has the digging ferret as its one loader; everything else keeps the small spinner.
  const digging = job.status === "running" && job.kind === "review";

  const head = (
    <div className="job-head">
      {live && !digging && <span className="spinner" aria-hidden="true" />}
      <span className="job-label">{job.label}</span>
      {!digging && (
        <span className="muted job-time">
          {job.model ? `${modelLabel(job.model)} · ` : ""}
          {elapsed(job.startedAt ?? job.createdAt, job.endedAt)}
        </span>
      )}
      {live ? (
        <button className="btn quiet" onClick={() => onCancel(job.id)}>
          Cancel
        </button>
      ) : (
        <button className="btn quiet" aria-label="Dismiss" onClick={() => onDismiss(job.id)}>
          ✕
        </button>
      )}
    </div>
  );

  const body = (
    <div className="job-body">
      {job.status === "queued" && <span className="muted">Queued{queuedAhead > 0 ? `, ${queuedAhead} ahead` : ""}</span>}
      {job.status === "running" && (
        <div className="job-live">
          <div className="job-phase">
            <span>{job.phase ?? "Working"}…</span>
            <span className="muted job-stats">
              {digging ? `${job.model ? `${modelLabel(job.model)} · ` : ""}${elapsed(job.startedAt ?? job.createdAt)}` : ""}
              {job.stats && (job.stats.tools > 0 || job.stats.files > 0)
                ? `${digging ? " · " : ""}${job.stats.files} file${job.stats.files === 1 ? "" : "s"} · ${job.stats.tools} step${job.stats.tools === 1 ? "" : "s"}`
                : ""}
            </span>
          </div>
          <div className="job-bar" aria-hidden="true" />
          <ol className="job-feed" aria-label="Activity">
            {(job.activity?.length ? job.activity : job.progress ? [job.progress] : []).map((line, i, all) => (
              <li key={`${i}-${line}`} className={i === all.length - 1 ? "now" : undefined}>
                {line}
              </li>
            ))}
          </ol>
        </div>
      )}
      {job.status === "done" && (
        <span>
          Done{job.note ? ` — ${job.note}` : ""}
          {job.reviewId && (
            <button className="btn link" onClick={() => onOpenReview(job.reviewId!)}>
              Open
            </button>
          )}
        </span>
      )}
      {job.status === "cancelled" && <span className="muted">Cancelled{job.error ? ` — ${job.error}` : ""}</span>}
      {job.status === "failed" && (
        <div>
          <span className="warn">{job.error ?? "Failed"}</span>
          {job.logTail.length > 0 && (
            <details className="job-log">
              <summary>Show log</summary>
              <pre>{job.logTail.join("\n")}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={`job job-${job.status}`} data-testid="job-card">
      {digging ? (
        <div className="job-digging">
          <FerretDigger size={46} />
          <div className="job-main">
            {head}
            {body}
          </div>
        </div>
      ) : (
        <>
          {head}
          {body}
        </>
      )}
    </div>
  );
}
