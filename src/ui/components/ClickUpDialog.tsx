import { useEffect, useMemo, useState } from "react";
import {
  fetchClickUpMembers, fetchClickUpStatus, saveClickUpToken, sendClickUpDm, sendToClickUp,
  type ClickUpPerson, type ClickUpStatus, type ClickUpWorkspace,
} from "../api";

interface Props {
  open: boolean;
  reviewId: string;
  reviewLabel: string;
  /** e.g. "🔴 1 · 🟠 0 · 🟡 2 · 🟢 4" — goes into the automatic message. */
  countsLine: string;
  /** The task the review was started with (pre-fills the task field). */
  defaultTask?: string;
  onClose(): void;
}

type Mode = "person" | "task";

const autoMessage = (first: string, label: string, counts: string) =>
  `Hi ${first}! I reviewed ${label} with Ferret — ${counts}. The review file is on the task below; tell me if you want to go through any finding together.`;

/** Export ▾ → Send to ClickUp…: DM a teammate (review as a linked Doc) or attach the .md to a task. */
export function ClickUpDialog({ open, reviewId, reviewLabel, countsLine, defaultTask, onClose }: Props) {
  const [status, setStatus] = useState<ClickUpStatus | null>(null);
  const [mode, setMode] = useState<Mode>("person");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<ClickUpWorkspace[] | null>(null);
  const [wsId, setWsId] = useState("");
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState<ClickUpPerson | null>(null);
  const [message, setMessage] = useState("");
  const [messageTouched, setMessageTouched] = useState(false);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ text: string; url: string; urlLabel: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSent(null);
    setBusy(false);
    setPerson(null);
    setQuery("");
    setMessage("");
    setMessageTouched(false);
    setTask(defaultTask ?? "");
    fetchClickUpStatus()
      .then((s) => {
        setStatus(s);
        if (s.configured) void loadMembers();
      })
      .catch(() => setStatus(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadMembers = async () => {
    try {
      const { workspaces: ws } = await fetchClickUpMembers();
      setWorkspaces(ws);
      setWsId((cur) => cur || ws[0]?.id || "");
    } catch (e) {
      setError((e as Error).message.replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/s, "$1"));
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const ws = useMemo(() => workspaces?.find((w) => w.id === wsId) ?? null, [workspaces, wsId]);
  const matches = useMemo(() => {
    if (!ws) return [];
    const q = query.trim().toLowerCase();
    const all = q ? ws.members.filter((m) => m.username.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q)) : ws.members;
    return all.slice(0, 8);
  }, [ws, query]);

  const pick = (p: ClickUpPerson) => {
    setPerson(p);
    if (!messageTouched) setMessage(autoMessage(p.username.split(/\s+/)[0], reviewLabel, countsLine));
  };

  if (!open) return null;
  const needsToken = status !== null && !status.configured;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      if (needsToken) {
        const { user } = await saveClickUpToken(token);
        setStatus((s) => ({ configured: true, user, recent: s?.recent ?? [], recentPeople: s?.recentPeople ?? [] }));
        setToken("");
        await loadMembers();
        setBusy(false);
        return; // token saved: the people list is now loading; the user clicks Send again
      }
      if (mode === "person") {
        if (!person || !wsId) return;
        const r = await sendClickUpDm(reviewId, { workspaceId: wsId, userId: person.id, username: person.username, message, task: task.trim() });
        setSent({
          text: `The review file is attached to ${r.taskName}, and ${r.username} got a chat message linking to it.`,
          url: r.url,
          urlLabel: "Open task",
        });
      } else {
        const r = await sendToClickUp(reviewId, task.trim());
        setSent({ text: `Sent to ${r.taskName}: the review file is attached and a summary comment is in the task's feed.`, url: r.url, urlLabel: "Open task" });
      }
    } catch (e) {
      setError((e as Error).message.replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/s, "$1"));
    } finally {
      setBusy(false);
    }
  };

  const canSend = needsToken ? token.trim().length > 0 : mode === "person" ? Boolean(person && message.trim() && task.trim()) : Boolean(task.trim());

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-narrow" role="dialog" aria-label="Send to ClickUp">
        <div className="modal-head">
          <strong>Send to ClickUp</strong>
          <button className="btn quiet" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {sent ? (
          <>
            <p>{sent.text}</p>
            <div className="actions">
              <a className="btn fix" href={sent.url} target="_blank" rel="noreferrer">
                {sent.urlLabel}
              </a>
              <button className="btn quiet" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : needsToken ? (
          <>
            <p className="muted">Ferret talks to ClickUp with your personal API token. It is saved once and stays on this computer.</p>
            <div className="field">
              <label className="label" htmlFor="cu-token">ClickUp API token</label>
              <input
                id="cu-token"
                type="password"
                value={token}
                placeholder="pk_…  — ClickUp → Settings → Apps → API Token"
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
            </div>
            {error && <p className="warn">{error}</p>}
            <div className="actions">
              <button className="btn fix" disabled={busy || !canSend} onClick={() => void send()}>
                {busy ? "Checking…" : "Save token"}
              </button>
              <button className="btn quiet" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="segmented tabs" role="tablist">
              <button role="tab" aria-selected={mode === "person"} onClick={() => setMode("person")}>
                Person
              </button>
              <button role="tab" aria-selected={mode === "task"} onClick={() => setMode("task")}>
                Task
              </button>
            </div>

            {mode === "person" ? (
              <>
                <p className="muted">
                  Attaches <strong>ferret-review-{reviewId}.md</strong> ({reviewLabel}) to a task (ClickUp's API only uploads files to tasks)
                  and sends the person a chat message, as you, linking to it.
                </p>
                {workspaces !== null && workspaces.length > 1 && (
                  <div className="field">
                    <label className="label" htmlFor="cu-ws">Workspace</label>
                    <select id="cu-ws" value={wsId} onChange={(e) => { setWsId(e.target.value); setPerson(null); }}>
                      {workspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label className="label" htmlFor="cu-search">To</label>
                  <input
                    id="cu-search"
                    value={person ? person.username : query}
                    placeholder={workspaces === null ? "Loading people…" : "Search people by name or email"}
                    onChange={(e) => {
                      setPerson(null);
                      setQuery(e.target.value);
                    }}
                    autoFocus
                  />
                  {!person && Boolean(status?.recentPeople.length) && !query.trim() && (
                    <div className="recent-tasks">
                      {status!.recentPeople
                        .filter((p) => !wsId || p.workspaceId === wsId)
                        .map((p) => {
                          const full = ws?.members.find((m) => m.id === p.id);
                          return (
                            <button key={p.id} className="btn quiet" disabled={!full} onClick={() => full && pick(full)}>
                              {p.username}
                            </button>
                          );
                        })}
                    </div>
                  )}
                  {!person && query.trim() && (
                    <ul className="pick-list">
                      {matches.map((m) => (
                        <li key={m.id}>
                          <button className="pick" onClick={() => pick(m)}>
                            <span className="pick-main">
                              {m.username}
                              {m.email ? <span className="pick-sub"> · {m.email}</span> : null}
                            </span>
                          </button>
                        </li>
                      ))}
                      {matches.length === 0 && <li className="pad muted">Nobody matches "{query.trim()}".</li>}
                    </ul>
                  )}
                </div>
                <div className="field">
                  <label className="label" htmlFor="cu-dm-task">Task to hold the file (e.g. the PR's task)</label>
                  <input
                    id="cu-dm-task"
                    value={task}
                    placeholder="https://app.clickup.com/t/…  (or a task id)"
                    onChange={(e) => setTask(e.target.value)}
                  />
                  {Boolean(status?.recent.length) && (
                    <div className="recent-tasks">
                      {status!.recent.map((t) => (
                        <button key={t.id} className="btn quiet" title={t.url} onClick={() => setTask(t.url)}>
                          {t.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {person && (
                  <div className="field">
                    <label className="label" htmlFor="cu-msg">Message (sent as you)</label>
                    <textarea
                      id="cu-msg"
                      rows={4}
                      value={message}
                      onChange={(e) => {
                        setMessage(e.target.value);
                        setMessageTouched(true);
                      }}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="muted">
                  Attaches <strong>ferret-review-{reviewId}.md</strong> ({reviewLabel}) to the task and posts a summary comment.
                </p>
                <div className="field">
                  <label className="label" htmlFor="cu-task">Task</label>
                  <input
                    id="cu-task"
                    value={task}
                    placeholder="https://app.clickup.com/t/…  (or a task id)"
                    onChange={(e) => setTask(e.target.value)}
                  />
                  {Boolean(status?.recent.length) && (
                    <div className="recent-tasks">
                      {status!.recent.map((t) => (
                        <button key={t.id} className="btn quiet" title={t.url} onClick={() => setTask(t.url)}>
                          {t.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {error && <p className="warn">{error}</p>}
            <div className="actions">
              <button className="btn fix" disabled={busy || !canSend} onClick={() => void send()}>
                {busy ? "Sending…" : "Send"}
              </button>
              <button className="btn quiet" onClick={onClose}>
                Cancel
              </button>
              {status?.user && <span className="muted small">Connected as {status.user}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
