import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { diffLines, type DiffLine } from "../../shared/diff";
import type { StepNote } from "../../shared/proposal";
import { highlight, type Tok } from "../highlight";

/** The rest of the file around the change (full-file view). `startLine` = 1-based line where `before` starts. */
export interface DiffContext {
  prefix: string[];
  suffix: string[];
  startLine: number;
}

interface Props {
  before?: string;
  after?: string;
  /** Path for syntax colours; plain text without it. */
  file?: string;
  /** Inline explanations: each is shown under the first `after` line containing its `at`. */
  notes?: StepNote[];
  /** Full-file view: unchanged lines before/after the change. Without it only the change is shown. */
  context?: DiffContext;
  /** Line number of the first shown line in the changes-only view. */
  firstLine?: number;
}

const SIGN = { same: " ", add: "+", del: "−" } as const;
type Row = DiffLine & { oldNo?: number; newNo?: number; changed: boolean };

/** Unified before → after diff of a step; each side is highlighted on its own, lines are matched back by index. */
export function DiffView({ before = "", after = "", file, notes, context, firstLine = 1 }: Props) {
  const rows = useMemo<Row[]>(() => {
    const mid = diffLines(before, after).map((l) => ({ ...l, changed: true }));
    const out: Row[] = [
      ...(context?.prefix ?? []).map((text) => ({ type: "same" as const, text, changed: false })),
      ...mid,
      ...(context?.suffix ?? []).map((text) => ({ type: "same" as const, text, changed: false })),
    ];
    let o = context ? 1 : firstLine;
    let n = o;
    for (const r of out) {
      if (r.type !== "add") r.oldNo = o++;
      if (r.type !== "del") r.newNo = n++;
    }
    return out;
  }, [before, after, context, firstLine]);

  // Note texts keyed by the index of the row they sit under (the first changed add/same row containing `at`).
  const noteAt = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const nt of notes ?? []) {
      const at = nt.at.trim();
      const i = rows.findIndex((l) => l.changed && l.type !== "del" && l.text.includes(at));
      if (i === -1) continue;
      m.set(i, [...(m.get(i) ?? []), nt.text]);
    }
    return m;
  }, [rows, notes]);

  const [toks, setToks] = useState<{ a: Tok[][]; b: Tok[][] } | null>(null);
  useEffect(() => {
    setToks(null);
    if (!file) return;
    const join = (mid: string) =>
      [...(context?.prefix ?? []), ...(mid ? mid.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : []), ...(context?.suffix ?? [])].join("\n");
    let cancelled = false;
    Promise.all([highlight(join(before), file), highlight(join(after), file)])
      .then(([a, b]) => !cancelled && setToks({ a: a.lines, b: b.lines }))
      .catch(() => {}); // plain text stays
    return () => {
      cancelled = true;
    };
  }, [before, after, file, context]);

  // Full-file view: bring the change into view when the step opens.
  const firstChange = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (context) firstChange.current?.scrollIntoView({ block: "center" });
  }, [context, before, after]);

  let i = 0;
  let j = 0;
  let marked = false;
  return (
    <pre className={`diff${context ? " full" : ""}`} data-testid="diff">
      {rows.map((l, n) => {
        let t: Tok[] | undefined;
        if (l.type === "del") t = toks?.a[i++];
        else if (l.type === "add") t = toks?.b[j++];
        else {
          t = toks?.b[j];
          i++;
          j++;
        }
        const explain = noteAt.get(n);
        const ref = l.changed && !marked ? ((marked = true), firstChange) : undefined;
        return (
          <div key={n} ref={ref}>
            <div className={`dl ${l.type}${l.changed ? " chg-row" : ""}`}>
              <span className="dno">{l.type === "del" ? l.oldNo : l.newNo}</span>
              <span className="dsign">{SIGN[l.type]}</span>
              <span className="dsrc">{t ? t.map((tok, k) => <span key={k} style={{ color: tok.color }}>{tok.content}</span>) : l.text}</span>
            </div>
            {explain?.map((text, k) => (
              <div key={k} className="dnote">
                <span className="dsign" aria-hidden="true">✎</span>
                <span className="dnote-text">{text}</span>
              </div>
            ))}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Where `snippet` sits in the file (whitespace-trimmed line match, nearest to `hint` = 1-based line).
 * Returns the 0-based start and the number of lines, or null when it is not there.
 */
export function locate(fileLines: string[], snippet: string, hint = 1): { start: number; len: number } | null {
  const snip = snippet.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.trim());
  if (snip.length === 0 || (snip.length === 1 && snip[0] === "")) return null;
  const trimmed = fileLines.map((l) => l.trim());
  const at = (s: number) => snip.every((x, k) => trimmed[s + k] === x);
  let best = -1;
  for (let s = 0; s + snip.length <= trimmed.length; s++) {
    if (at(s) && (best === -1 || Math.abs(s - (hint - 1)) < Math.abs(best - (hint - 1)))) best = s;
  }
  return best === -1 ? null : { start: best, len: snip.length };
}
