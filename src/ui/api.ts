import type { ClaudeConnectResult, ClaudeStatus, FileResponse, ReviewSummary, StoreEvent } from "../shared/api-types";
import type { Finding, FindingPatch, Review } from "../shared/schema";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const fetchReviews = () => fetch("/api/reviews").then((r) => json<ReviewSummary[]>(r));

export const fetchReview = (id: string) => fetch(`/api/reviews/${enc(id)}`).then((r) => json<Review>(r));

export const fetchFile = (id: string, path: string) =>
  fetch(`/api/reviews/${enc(id)}/file?path=${enc(path)}`).then((r) => json<FileResponse>(r));

export const patchFinding = (id: string, findingId: string, patch: FindingPatch) =>
  fetch(`/api/reviews/${enc(id)}/findings/${enc(findingId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => json<Finding>(r));

/** Asks the app to open vscode:// links in order (with a pause between). Rejects if the server can't. */
export const openInVsCode = (urls: string[]) =>
  fetch("/api/open-vscode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  }).then((r) => json<{ ok: boolean }>(r));

export const deleteReview =(id: string) =>
  fetch(`/api/reviews/${enc(id)}`, { method: "DELETE" }).then((r) => json<{ deleted: number }>(r));

export const clearReviews = () => fetch("/api/reviews", { method: "DELETE" }).then((r) => json<{ deleted: number }>(r));

export const fetchClaudeStatus =() => fetch("/api/claude/status").then((r) => json<ClaudeStatus>(r));

export const connectClaude = () =>
  fetch("/api/claude/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) =>
    json<ClaudeConnectResult>(r),
  );

/** Live updates from the server. EventSource reconnects by itself if the server restarts. */
export function subscribe(onEvent: (e: StoreEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as StoreEvent);
  return () => es.close();
}
