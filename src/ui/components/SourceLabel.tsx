import { sourceLabel } from "../../shared/git-parse";
import type { ReviewSource } from "../../shared/schema";

/** "PR #218 · workflowbuilder · title" with the PR title linking to the PR. */
export function SourceLabel({ source }: { source: ReviewSource }) {
  const text = sourceLabel(source);
  if (source.kind === "pr" && source.url) {
    return (
      <span className="source-label" title={source.url}>
        <a href={source.url} target="_blank" rel="noreferrer">
          {text}
        </a>
        {source.author && <span className="muted"> · by {source.author}</span>}
      </span>
    );
  }
  return (
    <span className="source-label" title={source.head}>
      {text}
    </span>
  );
}
