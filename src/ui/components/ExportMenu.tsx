import { useRef } from "react";

interface Props {
  hasReview: boolean;
  onCopyMarkdown(): void;
  onSaveMarkdown(): void;
  onSendClickUp(): void;
  onImportFile(file: File): void;
}

/** Header menu: Export ▾ (Copy Markdown / Save .md… / Send to ClickUp…) and Import review…. */
export function ExportMenu({ hasReview, onCopyMarkdown, onSaveMarkdown, onSendClickUp, onImportFile }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const close = () => detailsRef.current?.removeAttribute("open");
  return (
    <details className="menu" ref={detailsRef}>
      <summary className="btn quiet">Export ▾</summary>
      <div className="menu-items" onClick={close}>
        <button disabled={!hasReview} onClick={onCopyMarkdown}>
          Copy Markdown
        </button>
        <button disabled={!hasReview} onClick={onSaveMarkdown}>
          Save .md…
        </button>
        <button disabled={!hasReview} onClick={onSendClickUp}>
          Send to ClickUp…
        </button>
        <hr />
        <button onClick={() => fileRef.current?.click()}>Import review…</button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".md,.json,text/markdown,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportFile(f);
          e.target.value = "";
        }}
      />
    </details>
  );
}
