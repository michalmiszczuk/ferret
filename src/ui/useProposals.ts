// Proposal mode state for App: the list, the open proposal, the selected step, decisions (delivered straight into
// the proposing Claude session), keyboard, and the SSE events App forwards here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProposalSummary, StepView, StoreEvent } from "../shared/api-types";
import { acceptAllCommand, acceptStepsCommand, decisionCommand, isSettled, type DecisionKind } from "../shared/proposal";
import { acceptAll, acceptSteps, decideStep, deleteProposal, fetchProposal, fetchProposals, refreshStep, type DecisionResult, type ProposalFull } from "./api";

export type Mode = "reviews" | "proposals";
const MODE_KEY = "ferret.mode";

export function proposalIdFromUrl(): string | null {
  const m = location.pathname.match(/^\/p\/([\w-]+)/);
  return m ? m[1] : null;
}

/** A /p/<id> link wins; otherwise the mode used last time. */
export function initialMode(): Mode {
  if (proposalIdFromUrl()) return "proposals";
  try {
    return localStorage.getItem(MODE_KEY) === "proposals" ? "proposals" : "reviews";
  } catch {
    return "reviews";
  }
}

/** Accept needs the file to still match and the dependencies applied; an accepted step can still be declined;
 *  a failed step can be retried (accept again) or dropped (decline). */
export const canAccept = (s: StepView): boolean =>
  !s.stale && !s.blocked && (s.status === "pending" || s.status === "asked" || s.status === "revised" || s.status === "declined" || s.status === "failed");
export const canDecline = (s: StepView): boolean =>
  s.status === "pending" || s.status === "asked" || s.status === "revised" || s.status === "accepted" || s.status === "failed";
export const canAsk = (s: StepView): boolean => s.status !== "applied";
/** Can go into the approval queue: open, and the file still matches (prerequisites may be queued too). */
export const canQueue = (s: StepView): boolean =>
  !s.stale && (s.status === "pending" || s.status === "asked" || s.status === "revised" || s.status === "declined" || s.status === "failed");
export const remainingToAccept =(p: ProposalFull | null): number => (p ? p.steps.filter((s) => s.status === "pending" && !s.blocked).length : 0);

const errMsg = (e: unknown) => (e as Error).message.replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/s, "$1");

interface Deps {
  mode: Mode;
  setMode(m: Mode): void;
  showToast(msg: string, ms?: number, action?: { label: string; run(): void }): void;
  /** Whether a review is open in Reviews mode (a new proposal must not throw away a note being typed there). */
  reviewOpen(): boolean;
}

export function useProposals({ mode, setMode, showToast, reviewOpen }: Deps) {
  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [proposalId, setProposalId] = useState<string | null>(proposalIdFromUrl());
  const [proposal, setProposal] = useState<ProposalFull | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Approvals collected locally ("Approve & next", Ctrl/Shift-click) and sent to the chat in one message.
  // stepId → the comment that goes with the approval ("" = plain approve).
  const [queued, setQueued] = useState<Map<string, string>>(new Map());
  useEffect(() => setQueued(new Map()), [proposalId]);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef(proposalId);
  idRef.current = proposalId;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // private mode etc.: the switch still works for this page
    }
  }, [mode]);

  const loadList = useCallback(async () => {
    const list = await fetchProposals();
    setProposals(list);
    setProposalId((cur) => cur ?? list.find((p) => p.status === "active")?.id ?? list[0]?.id ?? null);
  }, []);
  useEffect(() => {
    loadList().catch(() => {});
  }, [loadList]);

  const reload = useCallback(
    (id: string) =>
      fetchProposal(id)
        .then((p) => idRef.current === id && setProposal(p))
        .catch(() => idRef.current === id && setProposal(null)),
    [],
  );
  useEffect(() => {
    if (!proposalId) {
      setProposal(null);
      return;
    }
    setProposal((p) => (p && p.id === proposalId ? p : null));
    void reload(proposalId);
  }, [proposalId, reload]);

  useEffect(() => {
    if (mode === "proposals" && proposalId && location.pathname !== `/p/${proposalId}`) history.pushState(null, "", `/p/${proposalId}`);
  }, [mode, proposalId]);

  // The selected step follows the proposal: the first unsettled one, unless the current pick still exists.
  useEffect(() => {
    if (!proposal) return;
    setStepId((cur) => (cur && proposal.steps.some((s) => s.stepId === cur) ? cur : (proposal.steps.find((s) => !isSettled(s)) ?? proposal.steps[0])?.stepId ?? null));
  }, [proposal]);

  const open = useCallback((id: string) => {
    setStepId(null);
    setProposalId(id);
  }, []);

  const onEvent = useCallback(
    (e: StoreEvent) => {
      if (!("proposalId" in e)) return;
      if (e.type === "proposal-deleted") {
        if (idRef.current === e.proposalId) {
          idRef.current = null;
          setProposalId(null);
          setProposal(null);
        }
        void loadList().catch(() => {});
        return;
      }
      void loadList().catch(() => {});
      if (e.type === "proposal-created") {
        // A new proposal pops in only when nothing is open in the current mode (like a new review: a message the
        // user is typing on a finding or a step must not be thrown away by the switch); otherwise it is offered.
        const openIt = () => {
          setMode("proposals");
          open(e.proposalId);
        };
        const somethingOpen = modeRef.current === "proposals" ? Boolean(idRef.current) : reviewOpen();
        if (!somethingOpen) openIt();
        else showToast("New proposal arrived.", 15000, { label: "Open it", run: openIt });
      } else if (e.proposalId === idRef.current) {
        void reload(e.proposalId);
      }
    },
    [loadList, reload, open, setMode, showToast, reviewOpen],
  );

  const feedback = useCallback(
    (r: { delivered: boolean; agent?: string; reason?: string }, command: string) => {
      if (r.delivered) showToast(`Delivered to ${r.agent}.`, 5000);
      else
        showToast(`Recorded — ${r.reason ?? "not delivered"}.`, 15000, {
          label: "Copy the command",
          run: () => void navigator.clipboard.writeText(command).catch(() => {}),
        });
    },
    [showToast],
  );
  const mergeStep = (id: string, step: StepView) =>
    setProposal((p) => (p && p.id === id ? { ...p, steps: p.steps.map((s) => (s.stepId === step.stepId ? step : s)) } : p));

  const run = useCallback(
    async (id: string, sid: string, go: () => Promise<DecisionResult>, command: string) => {
      setBusy(true);
      try {
        const r = await go();
        mergeStep(id, r.step);
        feedback(r, command);
      } catch (e) {
        showToast(`Decision failed: ${errMsg(e)}`, 8000);
      } finally {
        setBusy(false);
      }
    },
    [feedback, showToast],
  );

  const decide = useCallback(
    (kind: DecisionKind, text?: string) => {
      if (!proposal || !stepId) return;
      const t = text?.trim() || undefined;
      return run(proposal.id, stepId, () => decideStep(proposal.id, stepId, kind, t), decisionCommand(proposal.id, stepId, { kind, text: t }));
    },
    [proposal, stepId, run],
  );
  const refresh = useCallback(() => {
    if (!proposal || !stepId) return;
    return run(proposal.id, stepId, () => refreshStep(proposal.id, stepId), decisionCommand(proposal.id, stepId, { kind: "ask", text: "refresh" }));
  }, [proposal, stepId, run]);

  const acceptRemaining = useCallback(async () => {
    if (!proposal) return;
    const id = proposal.id;
    setBusy(true);
    try {
      const r = await acceptAll(id);
      if (r.steps.length === 0) {
        showToast(r.reason ?? "Nothing left to accept.", 5000);
        return;
      }
      for (const s of r.steps) mergeStep(id, s);
      feedback(r, acceptAllCommand(id));
    } catch (e) {
      showToast(`Accept all failed: ${errMsg(e)}`, 8000);
    } finally {
      setBusy(false);
    }
  }, [proposal, feedback, showToast]);

  // ---- approval queue ----
  const queueable = useCallback((sid: string) => {
    const s = proposal?.steps.find((x) => x.stepId === sid);
    return Boolean(s && canQueue(s));
  }, [proposal]);
  /** List click: plain = open the step; Ctrl = add/remove it (and the open one) to the queue; Shift = queue the range. */
  const clickStep = useCallback(
    (sid: string, mods: { ctrl: boolean; shift: boolean }) => {
      if (!proposal) return;
      if (mods.shift && stepId) {
        const ids = proposal.steps.map((s) => s.stepId);
        const [a, b] = [ids.indexOf(stepId), ids.indexOf(sid)].sort((x, y) => x - y);
        setQueued((q) => {
          const n = new Map(q);
          for (const id of ids.slice(a, b + 1).filter(queueable)) if (!n.has(id)) n.set(id, "");
          return n;
        });
      } else if (mods.ctrl) {
        setQueued((q) => {
          const n = new Map(q);
          if (n.size === 0 && stepId && stepId !== sid && queueable(stepId)) n.set(stepId, "");
          if (n.has(sid)) n.delete(sid);
          else if (queueable(sid)) n.set(sid, "");
          return n;
        });
      }
      setStepId(sid);
    },
    [proposal, stepId, queueable],
  );
  /** Mark the open step approved (locally, nothing sent yet) with an optional comment, and open the next step that
   *  still needs a decision. Approving a queued step again replaces its comment. */
  const approveAndNext = useCallback((text?: string) => {
    if (!proposal || !stepId || !queueable(stepId)) return;
    const next = new Map(queued).set(stepId, (text ?? "").trim());
    setQueued(next);
    const ids = proposal.steps.map((s) => s.stepId);
    const after = [...ids.slice(ids.indexOf(stepId) + 1), ...ids.slice(0, ids.indexOf(stepId))];
    const target = after.find((sid) => !next.has(sid) && queueable(sid));
    if (target) setStepId(target);
  }, [proposal, stepId, queued, queueable]);
  const clearQueue = useCallback(() => setQueued(new Map()), []);
  /** One delivery for every queued approval. */
  const sendQueued = useCallback(async () => {
    if (!proposal || queued.size === 0) return;
    const id = proposal.id;
    const ordered = proposal.steps.map((s) => s.stepId).filter((sid) => queued.has(sid));
    setBusy(true);
    try {
      const texts = Object.fromEntries([...queued].filter(([, t]) => t));
      const r = await acceptSteps(id, ordered, texts);
      for (const s of r.steps) mergeStep(id, s);
      setQueued(new Map());
      const skippedNote = r.skipped.length ? ` Skipped: ${r.skipped.map((x) => `${x.stepId} (${x.reason})`).join(", ")}.` : "";
      if (r.steps.length === 0) showToast(`Nothing accepted.${skippedNote}`, 10000);
      else if (r.delivered) showToast(`${r.steps.length} approved, delivered to ${r.agent}.${skippedNote}`, skippedNote ? 10000 : 5000);
      else
        showToast(`${r.steps.length} approved and recorded — ${r.reason ?? "not delivered"}.${skippedNote}`, 15000, {
          label: "Copy the command",
          run: () => void navigator.clipboard.writeText(acceptStepsCommand(id, r.steps.map((s) => s.stepId))).catch(() => {}),
        });
    } catch (e) {
      showToast(`Sending approvals failed: ${errMsg(e)}`, 8000);
    } finally {
      setBusy(false);
    }
  }, [proposal, queued, showToast]);

  const remove = useCallback(async () => {
    if (!proposal) return;
    if (!confirm(`Delete the proposal "${proposal.task.title}" (${proposal.steps.length} steps)? This can't be undone.`)) return;
    const id = proposal.id;
    try {
      await deleteProposal(id);
      if (idRef.current === id) {
        idRef.current = null;
        setProposalId(null);
        setProposal(null);
      }
      await loadList();
    } catch (e) {
      showToast(`Delete failed: ${errMsg(e)}`, 6000);
    }
  }, [proposal, loadList, showToast]);

  const move = useCallback(
    (delta: number) => {
      if (!proposal || proposal.steps.length === 0) return;
      const i = proposal.steps.findIndex((s) => s.stepId === stepId);
      setStepId(proposal.steps[Math.min(Math.max(i + delta, 0), proposal.steps.length - 1)].stepId);
    },
    [proposal, stepId],
  );

  // Keyboard (Proposals mode only, outside text boxes): j/k move, a accept, d decline, q ask.
  const step = proposal?.steps.find((s) => s.stepId === stepId) ?? null;
  useEffect(() => {
    if (mode !== "proposals") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT") {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") setQueued(new Map());
      else if (e.key === "n" && !busy) approveAndNext(askRef.current?.value);
      else if (e.key === "j") move(1);
      else if (e.key === "k") move(-1);
      else if (e.key === "q" && step && canAsk(step)) {
        e.preventDefault();
        askRef.current?.focus();
      } else if (!busy && step) {
        if (e.key === "a" && canAccept(step)) void decide("accept");
        else if (e.key === "d" && canDecline(step)) void decide("decline");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [mode, step, busy, move, decide, approveAndNext]);

  return {
    proposals, proposalId, proposal, step, stepId, setStepId, open, onEvent, decide, refresh, acceptRemaining, remove, busy, askRef,
    queued, clickStep, approveAndNext, sendQueued, clearQueue,
  };
}
