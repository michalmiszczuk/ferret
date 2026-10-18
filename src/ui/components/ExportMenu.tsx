import { useRef } from "react";

interface Props {
  hasReview: boolean;
  onCopyMarkdown(): void;
  onSaveMarkdown(): void;
  onImportFile(file: File): void;
}

/** Header menu: Export ▾ (Copy Markdown / Save .md…) and Import review…. */
export function ExportMenu({ hasReview, onCopyMarkdown, onSaveMarkdown, onImportFile }: Props) {
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
