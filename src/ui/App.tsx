import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClaudeStatus, Job, ReviewSummary } from "../shared/api-types";
import { claudeOpenUrl, realValue, vscodeFolderUrl } from "../shared/claude-link";
import { navOrder, type Filters } from "../shared/findings";
import { SEVERITIES, type FindingPatch, type Review } from "../shared/schema";
import {
  cancelJob, clearReviews, connectClaude, deleteReview, fetchClaudeStatus, fetchExport, fetchJobs, fetchLatestSession, fetchReview, fetchReviews,
  importReview, NeedsRepo, openInVsCode, patchFinding, saveFile, startDraft, startDraftAll, subscribe,
} from "./api";
import { sourceLabel } from "../shared/git-parse";
import { CodeView } from "./components/CodeView";
import { FindingsList } from "./components/FindingsList";
import { ConnectButton, Header } from "./components/Header";
import { JobCard } from "./components/JobCard";
import { ReviewPanel } from "./components/ReviewPanel";

function idFromUrl(): string | null {
  const m = location.pathname.match(/^\/r\/([\w-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(idFromUrl());
  const [review, setReview] = useState<Review | null>(null);
  const [selectedId, setSelectedIdRaw] = useState<string | null>(null);
  // Which step of the selected finding's path is shown (null = the finding itself).
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  // Selecting a finding always starts at its main location (same render, so no flash of a stale step).
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdRaw(id);
    setStepIndex(null);
  }, []);
  const [filters, setFilters] = useState<Filters>({ severities: [...SEVERITIES], status: "all" });
  const [doneOpen, setDoneOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; action?: { label: string; run(): void } } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reviewIdRef = useRef(reviewId);
  reviewIdRef.current = reviewId;

  const showToast = useCallback((msg: string, ms = 3000, action?: { label: string; run(): void }) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, action });
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  // Background jobs (reviews started from Ferret, reply drafts). Finished ones can be dismissed from the list.
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dismissedJobs, setDismissedJobs] = useState<Set<string>>(new Set());
  const openedAt = useRef(Date.now());
  const [panelOpen, setPanelOpen] = useState(() => new URLSearchParams(location.search).get("panel") === "review");
  const loadJobs = useCallback(() => fetchJobs().then(setJobs).catch(() => {}), []);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

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
        if (e.type === "job-updated") {
          // A finished review job opens its review when nothing is open; otherwise the review-created toast offers it.
          fetchJobs()
            .then((list) => {
              setJobs(list);
              const j = list.find((x) => x.id === e.jobId);
              if (j?.status === "done" && j.kind === "review" && j.reviewId && !reviewIdRef.current) {
                setSelectedId(null);
                setReviewId(j.reviewId);
              }
              if (j?.kind !== "review" && j?.reviewId === reviewIdRef.current && (j?.status === "done" || j?.status === "failed")) {
                fetchReview(j.reviewId!).then((r) => reviewIdRef.current === r.id && setReview(r)).catch(() => {});
              }
            })
            .catch(() => {});
          return;
        }
        if (e.type === "review-deleted") {
          if (e.reviewId === reviewIdRef.current) leaveReview();
          void loadReviews();
          return;
        }
        void loadReviews();
        if (e.type === "review-created") {
          // Jump to the new review only when nothing is open; otherwise offer it, so a message the user is
          // typing on a finding isn't thrown away by the switch.
          if (!reviewIdRef.current) {
            setSelectedId(null);
            setReviewId(e.reviewId);
          } else {
            showToast("New review arrived.", 15000, {
              label: "Open it",
              run: () => {
                setSelectedId(null);
                setReviewId(e.reviewId);
                setToast(null);
              },
            });
          }
        } else if (e.reviewId === reviewIdRef.current) {
          fetchReview(e.reviewId)
            .then((r) => {
              if (reviewIdRef.current === r.id) setReview(r); // the user may have switched away meanwhile
            })
            .catch(() => {});
        }
      }),
    [loadReviews, leaveReview, showToast, setSelectedId],
  );

  // The SSE "review-deleted" handler normally moves the view on before the HTTP response arrives;
  // the checks below only act if it hasn't (e.g. the event stream is reconnecting).
  const onDelete = useCallback(async () => {
    if (!review) return;
    if (!confirm(`Delete this review (${review.findings.length} findings)? This can't be undone.`)) return;
    const id = review.id;
    try {
      await deleteReview(id);
      if (reviewIdRef.current === id) leaveReview();
      await loadReviews();
    } catch (err) {
      showToast(`Delete failed: ${(err as Error).message}`);
    }
  }, [review, leaveReview, loadReviews, showToast]);

  const onClearAll = useCallback(async () => {
    if (!confirm(`Delete all ${reviews.length} reviews? This can't be undone.`)) return;
    try {
      await clearReviews();
      if (reviewIdRef.current) leaveReview();
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

  /** Patches a finding on the server. Returns false (after a toast) when the save failed. */
  const update = useCallback(
    async (findingId: string, patch: FindingPatch): Promise<boolean> => {
      if (!review) return false;
      const id = review.id;
      try {
        const updated = await patchFinding(id, findingId, patch);
        setReview((r) => (r && r.id === id ? { ...r, findings: r.findings.map((f) => (f.id === findingId ? updated : f)) } : r));
        return true;
      } catch (err) {
        showToast(`Update failed: ${(err as Error).message}`, 6000);
        return false;
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
      if (!(await update(findingId, { myNote: message, status: "fix_requested" }))) return; // nothing to send
      // 1) Open/focus the VS Code window of the repo, 2) open the Claude chat there with the prompt pre-filled
      // (the user presses Enter). The clipboard copy is the fallback if VS Code doesn't come up.
      // Fixes always go into the user's clone (source.repo), never into a Ferret snapshot. A review that came
      // from a chat returns to that chat; otherwise Ferret picks the chat most recently used in that repo.
      const folder = review.source?.repo ?? realValue(review.projectDir) ?? review.repoRoot;
      let sessionId = realValue(review.sessionId);
      if (!sessionId && folder) {
        try {
          sessionId = (await fetchLatestSession(folder))?.sessionId;
        } catch {
          // no lookup on an older server: a new chat opens instead
        }
      }
      const urls = [
        ...(folder && (review.source || sessionId) ? [vscodeFolderUrl(folder)] : []),
        claudeOpenUrl(text, sessionId),
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
      else if ((e.key === "]" || e.key === "[") && selected?.steps?.length) {
        const last = selected.steps.length - 1;
        if (e.key === "]") setStepIndex((s) => (s === null ? 0 : Math.min(s + 1, last)));
        else setStepIndex((s) => (s === null || s === 0 ? null : s - 1));
      } else if (e.key === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (selected && (selected.status === "open" || selected.status === "fix_requested")) {
        if (e.key === "d") void update(selected.id, { status: "dismissed" });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [nav, selectedId, selected, update]);

  const openReview = useCallback(
    (id: string) => {
      setSelectedId(null);
      setReviewId(id);
    },
    [setSelectedId],
  );
  // ---- reply drafts ----
  const liveJob = (j: Job) => j.status === "running" || j.status === "queued";
  const draftingAll = jobs.some((j) => j.kind === "draft-all" && j.reviewId === reviewId && liveJob(j));
  const draftingId = (id: string) => draftingAll || jobs.some((j) => j.kind === "draft" && j.reviewId === reviewId && j.findingId === id && liveJob(j));
  const onDraft = useCallback(
    (findingId: string) => {
      if (!review) return;
      startDraft(review.id, findingId)
        .then(loadJobs)
        .catch((e: Error) => showToast(`Draft failed: ${e.message}`, 6000));
    },
    [review, loadJobs, showToast],
  );
  const onDraftAll = useCallback(() => {
    if (!review) return;
    const open = review.findings.filter((f) => f.status === "open");
    const redo = open.some((f) => f.draft) && confirm("Some findings already have a reply. Redo all of them? (Cancel = only the missing ones)");
    startDraftAll(review.id, redo)
      .then(loadJobs)
      .catch((e: Error) => showToast(`Draft all failed: ${e.message}`, 6000));
  }, [review, loadJobs, showToast]);

  // ---- "Ask about this step" pre-fills the message box ----
  const [presetMessage, setPresetMessage] = useState<{ text: string; n: number } | undefined>(undefined);
  const onAsk = useCallback(
    (i: number) => {
      const step = selected?.steps?.[i];
      if (!step) return;
      setStepIndex(null);
      setPresetMessage((p) => ({ text: `About step ${i + 1} (${step.note}): `, n: (p?.n ?? 0) + 1 }));
      setTimeout(() => noteRef.current?.focus(), 50);
    },
    [selected],
  );
  const snapshotHint = review?.source?.worktree
    ? `Snapshot of ${sourceLabel(review.source)} — Claude's edits here don't touch your checkout; use Draft reply to tell the author.`
    : undefined;

  // ---- export / import ----
  const onCopyMarkdown = useCallback(async () => {
    if (!review) return;
    try {
      await navigator.clipboard.writeText(await fetchExport(review.id));
      showToast("Markdown copied.");
    } catch (e) {
      showToast(`Export failed: ${(e as Error).message}`, 6000);
    }
  }, [review, showToast]);
  const onSaveMarkdown = useCallback(async () => {
    if (!review) return;
    try {
      const text = await fetchExport(review.id);
      const name = `ferret-review-${review.id}.md`;
      try {
        const p = await saveFile(name, text);
        showToast(p ? `Saved ${p}` : "Save cancelled.", 5000);
      } catch {
        // no native dialog (terminal build): download instead
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (e) {
      showToast(`Export failed: ${(e as Error).message}`, 6000);
    }
  }, [review, showToast]);
  const [needsRepo, setNeedsRepo] = useState<{ label: string; candidates: string[]; onPicked(repo: string): void } | null>(null);
  const doImport = useCallback(
    async (text: string, repo?: string) => {
      try {
        const r = await importReview(text, repo);
        setNeedsRepo(null);
        await loadReviews();
        openReview(r.id);
        showToast(`Imported ${r.findings.length} findings${r.source?.worktree ? " at the reviewed commit" : ""}.`, 5000);
      } catch (e) {
        if (e instanceof NeedsRepo) {
          setNeedsRepo({ label: `Pick the local clone of ${e.ownerRepo || "this review's repo"}`, candidates: e.candidates, onPicked: (p) => void doImport(text, p) });
        } else showToast(`Import failed: ${(e as Error).message}`, 8000);
      }
    },
    [loadReviews, openReview, showToast],
  );
  const onImportFile = useCallback((file: File) => void file.text().then((t) => doImport(t)), [doImport]);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const leave = () => setDragging(false);
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer?.files[0];
      if (f && /\.(md|json)$/i.test(f.name)) onImportFile(f);
      else if (f) showToast("Drop a .md or .json review file.");
    };
    addEventListener("dragover", over);
    addEventListener("dragleave", leave);
    addEventListener("drop", drop);
    return () => {
      removeEventListener("dragover", over);
      removeEventListener("dragleave", leave);
      removeEventListener("drop", drop);
    };
  }, [onImportFile, showToast]);

  const JOB_ORDER = { running: 0, queued: 1, failed: 2, done: 3, cancelled: 4 } as const;
  // Finished jobs stay as cards until dismissed, but old history (from before this page opened) stays out of the way.
  const recent = (j: Job) => !j.endedAt || Date.parse(j.endedAt) > openedAt.current - 10 * 60 * 1000;
  const visibleJobs = jobs
    .filter((j) => (j.status === "queued" || j.status === "running" || j.status === "failed" || (j.status === "done" && j.kind === "review" && j.reviewId !== reviewId)) && recent(j) && !dismissedJobs.has(j.id))
    .sort((a, b) => JOB_ORDER[a.status] - JOB_ORDER[b.status] || a.createdAt.localeCompare(b.createdAt));
  const jobCards = visibleJobs.length > 0 && (
    <div className="jobs">
      {visibleJobs.map((j) => (
        <JobCard
          key={j.id}
          job={j}
          queuedAhead={jobs.filter((o) => o.kind === j.kind && o.status !== "done" && o.status !== "failed" && o.status !== "cancelled" && o.createdAt < j.createdAt).length}
          onCancel={(id) => void cancelJob(id).then(loadJobs).catch((e: Error) => showToast(`Cancel failed: ${e.message}`))}
          onOpenReview={(id) => {
            openReview(id);
            setDismissedJobs((s) => new Set(s).add(j.id));
          }}
          onDismiss={(id) => setDismissedJobs((s) => new Set(s).add(id))}
        />
      ))}
    </div>
  );

  return (
    <div className="app">
      <Header
        reviews={reviews}
        review={review}
        onSwitch={openReview}
        claude={claude}
        connecting={connecting}
        onConnect={onConnect}
        onDelete={onDelete}
        onClearAll={onClearAll}
        onReview={() => setPanelOpen(true)}
        onDraftAll={review?.source ? onDraftAll : undefined}
        draftingAll={draftingAll}
        onCopyMarkdown={() => void onCopyMarkdown()}
        onSaveMarkdown={() => void onSaveMarkdown()}
        onImportFile={onImportFile}
      />
      <ReviewPanel
        open={panelOpen || needsRepo !== null}
        needsRepo={needsRepo}
        onClose={() => {
          setPanelOpen(false);
          setNeedsRepo(null);
        }}
        onStarted={(job) => {
          setPanelOpen(false);
          showToast(`Review started: ${job.label}`);
          void loadJobs();
        }}
      />
      {dragging && <div className="drop-hint">Drop a Ferret review (.md) to import it</div>}
      {!review ? (
        // Keep the two-pane layout even when there is nothing to show yet.
        <div className="main">
          <FindingsList
            findings={[]}
            top={jobCards}
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
                  <li>
                    <button className="btn fix" onClick={() => setPanelOpen(true)}>
                      Review ▶
                    </button>
                    <span className="muted">a pull request, a commit, or your uncommitted changes — Ferret runs Claude for you</span>
                  </li>
                  <li>
                    Or, in a Claude Code chat: <code>/ai-review</code>, <code>/ai-review HEAD~3..HEAD</code>, <code>/ai-review #218</code>.
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
            top={jobCards}
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
              stepIndex={stepIndex}
              onStep={setStepIndex}
              onSelect={setSelectedId}
              onUpdate={update}
              onSend={sendFinding}
              onDraft={onDraft}
              drafting={draftingId(selected.id)}
              snapshotHint={snapshotHint}
              presetMessage={presetMessage}
              onAsk={selected.steps?.length ? onAsk : undefined}
              noteRef={noteRef}
            />
          ) : (
            <div className="welcome">{review.findings.length === 0 ? "Clean review. No findings 🎉" : "Select a finding."}</div>
          )}
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast.msg}
          {toast.action && (
            <button className="btn toast-action" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
