import { Fragment, useEffect, useRef, useState, type Ref } from "react";
import type { Anchor, FileResponse } from "../../shared/api-types";
import { vscodeUrl } from "../../shared/paths";
import type { Finding, FindingPatch, Review } from "../../shared/schema";
import { fetchFile } from "../api";
import { highlight, type Tok } from "../highlight";
import { CommentCard } from "./CommentCard";

interface Props {
  review: Review;
  finding: Finding;
  onSelect(id: string): void;
  onUpdate(findingId: string, patch: FindingPatch): void;
  onSend(findingId: string, message: string): void;
  noteRef: Ref<HTMLTextAreaElement>;
}

export function CodeView({ review, finding, onSelect, onUpdate, onSend, noteRef }: Props) {
  const [file, setFile] = useState<FileResponse | null>(null);
  const [tokens, setTokens] = useState<Tok[][] | null>(null);
  const [codeBg, setCodeBg] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);

  // New file → clear old content so tokens of one file never render over another.
  useEffect(() => {
    setFile(null);
    setTokens(null);
  }, [review.id, finding.file]);

  // (Re)load whenever the review changes too, so fixes made by Claude show up.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchFile(review.id, finding.file)
      .then((res) => {
        if (cancelled) return;
        setFile(res);
        if (res.exists) {
          highlight(res.content, finding.file)
            .then((t) => {
              if (cancelled) return;
              setTokens(t.lines);
              setCodeBg(t.bg);
            })
            .catch(() => {}); // plain text fallback stays
        }
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [review, finding.file]);

  const anchor: Anchor | undefined = file?.exists ? file.anchors[finding.id] : undefined;

  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [finding.id, anchor?.lineStart, file?.exists]);

  const href = vscodeUrl(review.repoRoot, finding.file, anchor?.lineStart ?? finding.lineStart);
  const head = (
    <div className="code-head">
      <span className="path">{finding.file}</span>
      <a className="btn" href={href}>
        Open in VS Code
      </a>
    </div>
  );
  const card = (state: Anchor["anchor"] | "missing") => (
    <CommentCard
      key={finding.id}
      finding={finding}
      anchor={state}
      onUpdate={(p) => onUpdate(finding.id, p)}
      onSend={(m) => onSend(finding.id, m)}
      noteRef={noteRef}
    />
  );

  if (error) {
    return (
      <section className="code">
        {head}
        <p className="warn pad">Could not load file: {error}</p>
      </section>
    );
  }
  if (!file) {
    return (
      <section className="code">
        {head}
        <p className="muted pad">Loading…</p>
      </section>
    );
  }
  if (!file.exists) {
    return (
      <section className="code">
        {head}
        <div className="code-body" ref={targetRef}>
          {card("missing")}
        </div>
      </section>
    );
  }

  const lines: Tok[][] = tokens ?? file.content.replace(/\r\n/g, "\n").split("\n").map((l) => [{ content: l }]);
  const changed = new Set(file.changedLines);
  const dotsByLine = new Map<number, Finding[]>();
  for (const f of review.findings) {
    const a = file.anchors[f.id];
    if (f.file !== finding.file || !a || a.anchor === "lost") continue;
    dotsByLine.set(a.lineStart, [...(dotsByLine.get(a.lineStart) ?? []), f]);
  }
  const range = anchor && anchor.anchor !== "lost" ? anchor : null;

  return (
    <section className="code">
      {head}
      <div className="code-body" style={codeBg ? { background: codeBg } : undefined}>
        {!range && <div ref={targetRef}>{card("lost")}</div>}
        {lines.map((toks, i) => {
          const n = i + 1;
          const hl = range !== null && n >= range.lineStart && n <= range.lineEnd;
          return (
            <Fragment key={n}>
              <div
                className={`line${hl ? ` hl sev-${finding.severity}` : ""}`}
                ref={range && n === range.lineStart ? targetRef : undefined}
              >
                <span className={`chg${changed.has(n) ? " on" : ""}`} />
                <span className="dots">
                  {(dotsByLine.get(n) ?? []).map((d) => (
                    <button
                      key={d.id}
                      className={`dot sev-${d.severity}`}
                      title={d.title}
                      aria-label={`Finding: ${d.title}`}
                      onClick={() => onSelect(d.id)}
                    />
                  ))}
                </span>
                <span className="ln">{n}</span>
                <code className="src">
                  {toks.map((t, k) => (
                    <span key={k} style={t.color ? { color: t.color } : undefined}>
                      {t.content}
                    </span>
                  ))}
                </code>
              </div>
              {range && n === range.lineEnd && card(range.anchor)}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
