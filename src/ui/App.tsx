import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClaudeStatus, ReviewSummary } from "../shared/api-types";
import { claudeOpenUrl, realValue, vscodeFolderUrl } from "../shared/claude-link";
import { navOrder, type Filters } from "../shared/findings";
import { SEVERITIES, type FindingPatch, type Review } from "../shared/schema";
import {
  clearReviews, connectClaude, deleteReview, fetchClaudeStatus, fetchReview, fetchReviews, openInVsCode, patchFinding,
  subscribe,
} from "./api";
import { CodeView } from "./components/CodeView";
import { FindingsList } from "./components/FindingsList";
import { ConnectButton, Header } from "./components/Header";

function idFromUrl(): string | null {
  const m = location.pathname.match(/^\/r\/([\w-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(idFromUrl());
  const [review, setReview] = useState<Review | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ severities: [...SEVERITIES], status: "all" });
  const [doneOpen, setDoneOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reviewIdRef = useRef(reviewId);
  reviewIdRef.current = reviewId;

  const showToast = useCallback((msg: string, ms = 3000) => {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }, []);

  // Claude Code connection (skills + MCP). null = this server can't do it (e.g. plain `review-app start`).
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const loadClaude = useCallback(() => {
    fetchClaudeStatus()
      .then(setClaude)
      .catch(() => setClaude(null));
  }, []);
  useEffect(loadClaude, [loadClaude]);
  const onConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const res = await connectClaude();
      showToast(res.message, 8000);
    } catch (err) {
      showToast(`Connecting failed: ${(err as Error).message}`, 8000);
    } finally {
      setConnecting(false);
      loadClaude();
    }
  }, [loadClaude, showToast]);

  /** Drop the open review; loadReviews() then picks the newest remaining one (or shows the empty state). */
  const leaveReview = useCallback(() => {
    reviewIdRef.current = null;
    setReviewId(null);
    setReview(null);
    setSelectedId(null);
    history.replaceState(null, "", "/");
  }, []);

  const loadReviews = useCallback(async () => {
    const list = await fetchReviews();
    setReviews(list);
    setReviewId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadReviews();
  }, [loadReviews]);

  useEffect(() => {
    if (!reviewId) return;
    if (location.pathname !== `/r/${reviewId}`) history.pushState(null, "", `/r/${reviewId}`);
    // Drop the previous review right away so nothing (auto-select, keyboard) acts on it while the new one loads.
    setReview((r) => (r && r.id === reviewId ? r : null));
    let cancelled = false;
    fetchReview(reviewId)
      .then((r) => !cancelled && setReview(r))
      .catch(() => !cancelled && setReview(null));
    return () => {
      cancelled = true;
    };
  }, [reviewId]);

  // Live updates: a new review jumps into view; changes to the open review refresh it.
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "review-deleted") {
          if (e.reviewId === reviewIdRef.current) leaveReview();
          void loadReviews();
          return;
        }
        void loadReviews();
        if (e.type === "review-created") {
          setSelectedId(null);
          setReviewId(e.reviewId);
        } else if (e.reviewId === reviewIdRef.current) {
          fetchReview(e.reviewId)
            .then((r) => {
              if (reviewIdRef.current === r.id) setReview(r); // the user may have switched away meanwhile
            })
            .catch(() => {});
        }
      }),
    [loadReviews, leaveReview],
  );

  const onDelete = useCallback(async () => {
    if (!review) return;
    if (!confirm(`Delete this review (${review.findings.length} findings)? This can't be undone.`)) return;
    try {
      await deleteReview(review.id);
      leaveReview();
      await loadReviews();
    } catch (err) {
      showToast(`Delete failed: ${(err as Error).message}`);
    }
  }, [review, leaveReview, loadReviews, showToast]);

  const onClearAll = useCallback(async () => {
    if (!confirm(`Delete all ${reviews.length} reviews? This can't be undone.`)) return;
    try {
      await clearReviews();
      leaveReview();
      await loadReviews();
    } catch (err) {
      showToast(`Clear failed: ${(err as Error).message}`);
    }
  }, [reviews.length, leaveReview, loadReviews, showToast]);

  useEffect(() => {
    const onPop = () => setReviewId(idFromUrl());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const nav = useMemo(() => (review ? navOrder(review.findings, filters, doneOpen) : []), [review, filters, doneOpen]);
  const selected = review?.findings.find((f) => f.id === selectedId) ?? null;

  useEffect(() => {
    if (review && review.id === reviewId && !selected && nav.length > 0) setSelectedId(nav[0].id);
  }, [review, reviewId, selected, nav]);

  const update = useCallback(
    async (findingId: string, patch: FindingPatch) => {
      if (!review) return;
      const id = review.id;
      try {
        const updated = await patchFinding(id, findingId, patch);
        setReview((r) => (r && r.id === id ? { ...r, findings: r.findings.map((f) => (f.id === findingId ? updated : f)) } : r));
      } catch (err) {
        showToast(`Update failed: ${(err as Error).message}`);
      }
    },
    [review, showToast],
  );

  /** Sends one finding to Claude with the user's message: saved on the finding, and pre-filled in Claude's prompt. */
  const sendFinding = useCallback(
    async (findingId: string, message: string) => {
      if (!review) return;
      const oneLine = message.replace(/\s+/g, " ").trim();
      const text = `/apply-review ${review.id} ${findingId}${oneLine ? ` ${oneLine}` : ""}`;
      // Copy first, while this window still has focus: VS Code takes focus next, and if the Claude tab is
      // already open the extension only focuses it (it won't pre-fill), so the user pastes.
      let copied = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        copied = false;
      }
      await update(findingId, { myNote: message, status: "fix_requested" });
      // 1) Focus the VS Code window of the Claude session's folder, 2) open the Claude panel there with the
      // prompt pre-filled (the user presses Enter). The clipboard copy is the fallback if VS Code doesn't come up.
      const folder = realValue(review.projectDir);
      const urls = [
        ...(folder && realValue(review.sessionId) ? [vscodeFolderUrl(folder)] : []),
        claudeOpenUrl(text, review.sessionId),
      ];
      try {
        await openInVsCode(urls); // the app opens them: no browser click-timing limits
      } catch {
        location.href = urls[urls.length - 1]; // older server: open the Claude link directly
      }
      showToast(
        copied
          ? "Claude opened in VS Code. If the box is empty, press Ctrl+V, then Enter."
          : `Claude opened in VS Code. Type: ${text}`,
        8000,
      );
    },
    [review, update, showToast],
  );

  // Keyboard: j/k move, f fix, d dismiss, n note, Esc leaves the note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT") {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || nav.length === 0) return;
      const idx = nav.findIndex((f) => f.id === selectedId);
      if (e.key === "j") setSelectedId(nav[Math.min(idx + 1, nav.length - 1)].id);
      else if (e.key === "k") setSelectedId(nav[Math.max(idx - 1, 0)].id);
      else if (e.key === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (selected && (selected.status === "open" || selected.status === "fix_requested")) {
        if (e.key === "d") void update(selected.id, { status: "dismissed" });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [nav, selectedId, selected, update]);

  return (
    <div className="app">
      <Header
        reviews={reviews}
        review={review}
        onSwitch={(id) => {
          setSelectedId(null);
          setReviewId(id);
        }}
        claude={claude}
        connecting={connecting}
        onConnect={onConnect}
        onDelete={onDelete}
        onClearAll={onClearAll}
      />
      {!review ? (
        // Keep the two-pane layout even when there is nothing to show yet.
        <div className="main">
          <FindingsList
            findings={[]}
            filters={filters}
            onFiltersChange={setFilters}
            selectedId={null}
            onSelect={() => {}}
            doneOpen={false}
            onToggleDone={() => {}}
          />
          <div className="welcome">
            {reviews.length === 0 ? (
              <div className="get-started">
                <p>No reviews yet.</p>
                <ol>
                  {claude && !claude.connected && (
                    <li>
                      <ConnectButton connecting={connecting} onConnect={onConnect} />
                      <span className="muted">installs the /ai-review skill and links Claude Code to this app</span>
                    </li>
                  )}
                  <li>Start a new Claude Code session in your project.</li>
                  <li>
                    Run <code>/ai-review</code> (uncommitted changes) or <code>/ai-review src/some/folder</code>.
                  </li>
                </ol>
              </div>
            ) : (
              "Loading…"
            )}
          </div>
        </div>
      ) : (
        <div className="main">
          <FindingsList
            findings={review.findings}
            filters={filters}
            onFiltersChange={setFilters}
            selectedId={selectedId}
            onSelect={setSelectedId}
            doneOpen={doneOpen}
            onToggleDone={() => setDoneOpen((o) => !o)}
          />
          {selected ? (
            <CodeView
              review={review}
              finding={selected}
              onSelect={setSelectedId}
              onUpdate={update}
              onSend={sendFinding}
              noteRef={noteRef}
            />
          ) : (
            <div className="welcome">{review.findings.length === 0 ? "Clean review. No findings 🎉" : "Select a finding."}</div>
          )}
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
