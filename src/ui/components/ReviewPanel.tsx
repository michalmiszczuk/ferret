import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommitSummary, EnvStatus, Job, PrSummary } from "../../shared/api-types";
import { originMatches, parsePrUrl, parseRange } from "../../shared/git-parse";
import { DEFAULT_REVIEW_MODEL, MODELS, versionBelow } from "../../shared/models";

const MODEL_KEY = "ferret.reviewModel";
function savedModel(): string {
  try {
    const m = localStorage.getItem(MODEL_KEY);
    return m && MODELS.some((x) => x.id === m) ? m : DEFAULT_REVIEW_MODEL;
  } catch {
    return DEFAULT_REVIEW_MODEL;
  }
}
import {
  fetchCommits, fetchEnv, fetchPrs, fetchRepoInfo, fetchRepos, fetchWhiteboardStatus, NeedsRepo, pickFolder, startJob,
  type RepoInfo, type StartJobScope, type WhiteboardMode, type WhiteboardStatus,
} from "../api";

const WB_KEY = "ferret.whiteboard";

type Tab = "pr" | "commit" | "changes";

interface Props {
  open: boolean;
  onClose(): void;
  onStarted(job: Job): void;
  /** Pre-filled when the panel is reused to pick a clone (PR URL or import matched nothing). */
  needsRepo?: { label: string; candidates: string[]; onPicked(repo: string): void } | null;
}

const GH_HINT = "GitHub CLI isn't available/logged in. Install it and run `gh auth login`, or review by branch instead.";
const CLAUDE_HINT = "Claude Code CLI not found. Ferret runs reviews with the `claude` command; install Claude Code or add it to PATH.";

export function ReviewPanel({ open, onClose, onStarted, needsRepo }: Props) {
  const [tab, setTab] = useState<Tab>("changes");
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [typedRepo, setTypedRepo] = useState("");
  const [canBrowse, setCanBrowse] = useState(true);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [prUrl, setPrUrl] = useState("");
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [prNumber, setPrNumber] = useState<number | null>(null);
  const [prsError, setPrsError] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [commitQuery, setCommitQuery] = useState("");
  const [sel, setSel] = useState<{ from?: string; to?: string }>({});
  const [typedRev, setTypedRev] = useState("");
  const [branchMode, setBranchMode] = useState(false);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wb, setWb] = useState<WhiteboardStatus | null>(null);
  const [whiteboard, setWhiteboardState] = useState<WhiteboardMode>(() => {
    try {
      const v = localStorage.getItem(WB_KEY);
      return v === "draw" || v === "explain" ? v : "off";
    } catch {
      return "off";
    }
  });
  const setWhiteboard = (mode: WhiteboardMode) => {
    setWhiteboardState(mode);
    try {
      localStorage.setItem(WB_KEY, mode);
    } catch {
      // session only
    }
  };
  const [model, setModelState] = useState(savedModel);
  const setModel = (m: string) => {
    setModelState(m);
    try {
      localStorage.setItem(MODEL_KEY, m);
    } catch {
      // remembered for this session only
    }
  };

  // Load environment + recent repos when opened.
  useEffect(() => {
    if (!open) return;
    setError(null);
    fetchEnv().then(setEnv).catch(() => setEnv(null));
    fetchWhiteboardStatus().then(setWb).catch(() => setWb(null));
    fetchRepos()
      .then(({ repos }) => {
        const list = needsRepo?.candidates.length ? [...new Set([...needsRepo.candidates, ...repos])] : repos;
        setRepos(list);
        setRepo((r) => r || list[0] || "");
      })
      .catch(() => {});
  }, [open, needsRepo]);

  // Repo details whenever the repo changes.
  useEffect(() => {
    if (!open || !repo) return setInfo(null);
    fetchRepoInfo(repo)
      .then((i) => {
        setInfo(i);
        setBase((b) => b || i.defaultBranch);
        setError(null);
      })
      .catch((e: Error) => {
        setInfo(null);
        setError(e.message.replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1"));
      });
  }, [open, repo]);

  useEffect(() => {
    if (!open || !repo || !info) return;
    if (tab === "pr") {
      setPrsError(null);
      fetchPrs(repo).then(setPrs).catch((e: Error) => { setPrs([]); setPrsError(e.message.includes("503") ? GH_HINT : e.message); });
    }
    if (tab === "commit") fetchCommits(repo).then(setCommits).catch(() => setCommits([]));
  }, [open, repo, info, tab]);

  // Pasting a PR URL: switch tab, pick the number, and auto-select a matching clone.
  // "#218" / "218" picks that PR directly; any other text filters the list below.
  const onPrUrl = useCallback(
    async (url: string) => {
      setPrUrl(url);
      const direct = /^#?(\d+)$/.exec(url.trim());
      const pr = parsePrUrl(url);
      if (!pr) {
        setPrNumber(direct ? Number(direct[1]) : null);
        return;
      }
      if (pr.host === "bitbucket") {
        setTab("commit");
        setBranchMode(true);
        setError("Bitbucket PR: paste the PR's source branch name below (shown on the PR page) and pick the local clone.");
        return;
      }
      setPrNumber(pr.number);
      if (info?.originOwnerRepo && originMatches(`https://github.com/${info.originOwnerRepo}`, pr.ownerRepo)) return;
      for (const r of repos) {
        try {
          const i = await fetchRepoInfo(r);
          if (i.originOwnerRepo && originMatches(`https://github.com/${i.originOwnerRepo}`, pr.ownerRepo)) {
            setRepo(r);
            return;
          }
        } catch {
          // skip unreadable repos
        }
      }
      setError(`No local clone of ${pr.ownerRepo} known yet: click Browse… and pick its folder.`);
    },
    [repos, info],
  );

  const browse = async () => {
    try {
      const p = await pickFolder();
      if (p) {
        setRepos((rs) => [p, ...rs.filter((x) => x !== p)]);
        setRepo(p);
      }
    } catch {
      setCanBrowse(false);
    }
  };

  const scope = useMemo((): StartJobScope | null => {
    if (tab === "pr") {
      // A URL names the repo too: without a repo the server finds the clone (or asks for it); with one it
      // refuses a clone of a different repo.
      if (prUrl.trim() && parsePrUrl(prUrl)?.host === "github") return { type: "pr", url: prUrl.trim(), ...(repo ? { repo } : {}) };
      if (prNumber && repo) return { type: "pr", repo, number: prNumber };
      return null;
    }
    if (!repo) return null;
    if (tab === "changes") return { type: "changes", repo };
    if (branchMode) return branch ? { type: "branch", repo, branch, base: base || undefined } : null;
    const typed = typedRev.trim();
    if (typed) {
      const r = parseRange(typed);
      return r ? { type: "range", repo, from: r.from, to: r.to } : { type: "commit", repo, sha: typed };
    }
    if (sel.from && sel.to) return { type: "range", repo, from: sel.from, to: sel.to };
    if (sel.from) return { type: "commit", repo, sha: sel.from };
    return null;
  }, [repo, tab, prNumber, prUrl, branchMode, branch, base, typedRev, sel]);

  const start = async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      const job = await startJob(scope, model, wb?.registered ? whiteboard : "off");
      onStarted(job);
    } catch (e) {
      if (e instanceof NeedsRepo) {
        setError(
          e.candidates.length
            ? `Several clones of ${e.ownerRepo} found: pick one in Repository (${e.candidates.join(", ")}).`
            : `No local clone of ${e.ownerRepo} known yet: click Browse… and pick its folder.`,
        );
      }
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Commit list selection: click = single, shift-click = range (older..newer).
  const clickCommit = (c: CommitSummary, shift: boolean) => {
    setTypedRev("");
    setSel((s) => {
      if (!shift || !s.from) return { from: c.sha };
      const a = commits.findIndex((x) => x.sha === s.from);
      const b = commits.findIndex((x) => x.sha === c.sha);
      if (a === -1 || b === -1 || a === b) return { from: c.sha };
      // commits are newest-first: the older one is the (exclusive) start → use its parent via `^`
      const [newer, older] = a < b ? [commits[a], commits[b]] : [commits[b], commits[a]];
      return { from: `${older.sha}^`, to: newer.sha };
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const cq = commitQuery.trim().toLowerCase();
  const shownCommits = cq ? commits.filter((c) => `${c.short} ${c.sha} ${c.subject} ${c.author}`.toLowerCase().includes(cq)) : commits;
  const ghMissing = env && !(env.gh.installed && env.gh.loggedIn);
  const claudeMissing = env && !env.claude.installed;
  const chosen = MODELS.find((m) => m.id === model);
  const cliTooOld =
    chosen?.minCli && env?.claude.version && versionBelow(env.claude.version, chosen.minCli)
      ? `${chosen.label} needs Claude Code ${chosen.minCli} or newer; yours is ${env.claude.version}. Run \`claude update\` in a terminal, or pick another model.`
      : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={needsRepo ? needsRepo.label : "Review"}>
        <div className="modal-head">
          <strong>{needsRepo ? needsRepo.label : "Review"}</strong>
          <button className="btn quiet" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {claudeMissing && <p className="warn">{CLAUDE_HINT}</p>}

        <div className="field">
          <label className="label">Repository</label>
          <div className="row-inline">
            {repos.length > 0 ? (
              <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted">No repos yet</span>
            )}
            {canBrowse ? (
              <button className="btn" onClick={browse}>
                Browse…
              </button>
            ) : (
              <>
                <input placeholder="C:\path\to\repo" value={typedRepo} onChange={(e) => setTypedRepo(e.target.value)} />
                <button className="btn" onClick={() => typedRepo && (setRepos((rs) => [typedRepo, ...rs]), setRepo(typedRepo))}>
                  Use
                </button>
              </>
            )}
          </div>
          {info && (
            <div className="muted small">
              {info.repoName}{info.originOwnerRepo ? ` · ${info.originOwnerRepo}` : ""} · default branch {info.defaultBranch} · HEAD {info.head.slice(0, 7)}
            </div>
          )}
        </div>

        {needsRepo ? (
          <div className="actions">
            <button className="btn fix" disabled={!repo || !info} onClick={() => needsRepo.onPicked(repo)}>
              Use this clone
            </button>
          </div>
        ) : (
          <>
            <div className="segmented tabs" role="tablist">
              {(["pr", "commit", "changes"] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === "pr" ? "Pull request" : t === "commit" ? "Commit" : "Changes"}
                </button>
              ))}
            </div>

            {tab === "pr" && (
              <div className="field">
                <label className="label">Pull request</label>
                <input
                  placeholder="Paste a link or #number, or type to search the open PRs"
                  value={prUrl}
                  onChange={(e) => void onPrUrl(e.target.value)}
                />
                {ghMissing && <p className="warn small">{GH_HINT}</p>}
                {prsError && <p className="warn small">{prsError}</p>}
                {(() => {
                  const typed = prUrl.trim();
                  const direct = /^#?(\d+)$/.exec(typed); // digits pick that PR number and narrow the list
                  const q = parsePrUrl(prUrl) ? "" : direct ? direct[1] : typed.toLowerCase();
                  const shown = q
                    ? prs.filter((p) => `#${p.number} ${p.title} ${p.author} ${p.headRefName}`.toLowerCase().includes(q))
                    : prs;
                  if (prs.length === 0) return null;
                  if (shown.length === 0) {
                    return (
                      <p className="muted small">
                        {direct
                          ? `#${direct[1]} is not in the open-PR list — Start review will fetch it anyway.`
                          : `No open PR matches "${typed}".`}
                      </p>
                    );
                  }
                  return (
                    <ul className="pick-list">
                      {shown.map((p) => (
                        <li key={p.number}>
                          <button className={`pick${prNumber === p.number ? " on" : ""}`} onClick={() => { setPrNumber(p.number); setPrUrl(p.url); }}>
                            <span className="pick-main">#{p.number} {p.title}</span>
                            <span className="pick-sub">{p.author} · {p.headRefName} · {new Date(p.updatedAt).toLocaleDateString()}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  );
                })()}
              </div>
            )}

            {tab === "commit" && (
              <div className="field">
                <div className="row-inline">
                  <label className="label">{branchMode ? "Branch vs base" : "Commit or range"}</label>
                  <button className="btn quiet" onClick={() => setBranchMode((m) => !m)}>
                    {branchMode ? "Pick commits instead" : "Compare a branch instead"}
                  </button>
                </div>
                {branchMode ? (
                  <div className="row-inline">
                    <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                      <option value="">— branch —</option>
                      {info?.branches.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                    <span className="muted">vs</span>
                    <input value={base} onChange={(e) => setBase(e.target.value)} placeholder={info?.defaultBranch ?? "main"} />
                  </div>
                ) : (
                  <>
                    <input placeholder="3f2a1c9, HEAD~1, or HEAD~3..HEAD" value={typedRev} onChange={(e) => { setTypedRev(e.target.value); setSel({}); }} />
                    <div className="muted small">Or pick from the latest commits: click one, shift-click another for a range.</div>
                    <input
                      className="list-filter"
                      placeholder="Search commits by message, author or sha"
                      value={commitQuery}
                      onChange={(e) => setCommitQuery(e.target.value)}
                    />
                    <ul className="pick-list commits">
                      {shownCommits.map((c) => {
                        const on = sel.from === c.sha || sel.to === c.sha || sel.from === `${c.sha}^`;
                        return (
                          <li key={c.sha}>
                            <button className={`pick${on ? " on" : ""}`} onClick={(e) => clickCommit(c, e.shiftKey)}>
                              <span className="pick-main"><code>{c.short}</code> {c.subject}</span>
                              <span className="pick-sub">{c.author} · {c.date}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}

            {tab === "changes" && <p className="muted">Reviews staged, unstaged and untracked changes of the selected repository.</p>}

            {error && <p className="warn">{error}</p>}
            <div className="field model-field">
              <label className="label" htmlFor="review-model">Model</label>
              <select id="review-model" value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}{m.id === DEFAULT_REVIEW_MODEL ? " (default)" : ""} · {m.hint}
                  </option>
                ))}
              </select>
              {cliTooOld && <p className="warn">{cliTooOld}</p>}
            </div>
            {wb?.registered && (
              <div className="field">
                <label className="label" htmlFor="review-wb">Whiteboard</label>
                <select id="review-wb" value={whiteboard} onChange={(e) => setWhiteboard(e.target.value as WhiteboardMode)}>
                  <option value="off">Off · review in Ferret only</option>
                  <option value="draw">Draw the findings on Whiteboard when done</option>
                  <option value="explain">Explain first · Claude draws the change on Whiteboard, then reviews with that map (≈2× time)</option>
                </select>
                {whiteboard !== "off" && !wb.running && <p className="muted small">Whiteboard isn't running now; Ferret will start it.</p>}
                {whiteboard === "explain" && (
                  <p className="muted small">If a Whiteboard of this PR already exists it is reused and no explanation pass runs.</p>
                )}
              </div>
            )}
            <div className="actions">
              <button className="btn fix" disabled={!scope || busy || Boolean(claudeMissing) || Boolean(cliTooOld)} onClick={start}>
                {busy ? "Starting…" : "Start review"}
              </button>
              <span className="muted small">
                {scope
                  ? "Runs Claude in the background; findings appear here when done."
                  : tab === "pr"
                    ? "Paste a GitHub PR URL, or pick a clone and choose one of its open PRs."
                    : !repo
                      ? "Pick a repository first (Browse… to add one)."
                      : branchMode
                        ? "Pick a branch to compare."
                        : "Pick a commit from the list (shift-click for a range) or type a revision."}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
