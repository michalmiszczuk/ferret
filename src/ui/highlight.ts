import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";

export type Tok = { content: string; color?: string };

const THEME = "github-dark-default";

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", cs: "csharp",
  rb: "ruby", php: "php", css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
  md: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", sql: "sql", c: "c", h: "c",
  cpp: "cpp", hpp: "cpp", swift: "swift", xml: "xml", toml: "toml",
};

export function langFromPath(p: string): BundledLanguage | "text" {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT[ext];
  return lang && lang in bundledLanguages ? (lang as BundledLanguage) : "text";
}

let highlighter: Promise<Highlighter> | null = null;

/** One token array per line. Languages are loaded on first use. */
export async function highlight(code: string, filePath: string): Promise<Tok[][]> {
  highlighter ??= createHighlighter({ themes: [THEME], langs: [] });
  const h = await highlighter;
  const lang = langFromPath(filePath);
  if (lang !== "text" && !h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
  const lines = h.codeToTokensBase(code.replace(/\r\n/g, "\n"), { lang, theme: THEME });
  return lines.map((line) => line.map((t) => ({ content: t.content, color: t.color })));
}
