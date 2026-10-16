import { bundledLanguages, createHighlighter, type BundledLanguage, type BundledTheme, type Highlighter } from "shiki";

export type Tok = { content: string; color?: string };
export interface Highlighted {
  lines: Tok[][];
  bg?: string; // editor background of the theme, so the code panel matches VS Code
}

const FALLBACK_THEME = "github-dark-default";

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

/** Uses the user's VS Code theme when the server can find it, otherwise a neutral dark default. */
async function setup(): Promise<{ h: Highlighter; theme: string }> {
  const h = await createHighlighter({ themes: [FALLBACK_THEME], langs: [] });
  try {
    const res = await fetch("/api/code-theme");
    if (res.status === 200) {
      const theme = await res.json();
      await h.loadTheme(theme);
      return { h, theme: theme.name as string };
    }
  } catch {
    // keep the fallback theme
  }
  return { h, theme: FALLBACK_THEME };
}

let ready: ReturnType<typeof setup> | null = null;

/** One token array per line. Languages are loaded on first use. */
export async function highlight(code: string, filePath: string): Promise<Highlighted> {
  ready ??= setup();
  const { h, theme } = await ready;
  const lang = langFromPath(filePath);
  if (lang !== "text" && !h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
  // `theme` may be the user's VS Code theme loaded at runtime; Shiki's type only lists bundled names.
  const lines = h.codeToTokensBase(code.replace(/\r\n/g, "\n"), { lang, theme: theme as BundledTheme });
  return {
    lines: lines.map((line) => line.map((t) => ({ content: t.content, color: t.color }))),
    bg: h.getTheme(theme).bg,
  };
}
