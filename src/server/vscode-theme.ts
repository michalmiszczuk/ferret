import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A VS Code color theme as Shiki accepts it (`tokenColors` + `colors`). */
export interface VsCodeTheme {
  name: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  [key: string]: unknown;
}

/** JSON with comments and trailing commas (VS Code settings and theme files). Leaves strings untouched. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function readJsonc(file: string): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonc(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type ThemeData = { colors: Record<string, string>; tokenColors: unknown[]; [key: string]: unknown };

/** Loads a theme file, merging an `include`d base theme (the including theme wins on conflicts). */
async function loadThemeFile(file: string, depth = 0): Promise<ThemeData | null> {
  const json = await readJsonc(file);
  if (!json) return null;
  let colors = (json.colors as Record<string, string>) ?? {};
  let tokenColors = Array.isArray(json.tokenColors) ? json.tokenColors : [];
  if (typeof json.include === "string" && depth < 5) {
    const base = await loadThemeFile(path.resolve(path.dirname(file), json.include), depth + 1);
    if (base) {
      colors = { ...base.colors, ...colors };
      tokenColors = [...base.tokenColors, ...tokenColors];
    }
  }
  return { ...json, colors, tokenColors };
}

function defaultSettingsPath(): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? os.homedir(), "Code", "User", "settings.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "settings.json");
  return path.join(os.homedir(), ".config", "Code", "User", "settings.json");
}

/**
 * The color theme VS Code currently uses, read from the user's settings and installed extensions.
 * Returns null for built-in themes (they ship inside VS Code itself) or when nothing is found.
 */
export async function findVsCodeTheme(
  opts: { settingsPath?: string; extensionsDir?: string } = {},
): Promise<VsCodeTheme | null> {
  const settings = await readJsonc(opts.settingsPath ?? defaultSettingsPath());
  const wanted = settings?.["workbench.colorTheme"];
  if (typeof wanted !== "string") return null;

  const extensionsDir = opts.extensionsDir ?? path.join(os.homedir(), ".vscode", "extensions");
  let dirs: string[];
  try {
    dirs = await fs.readdir(extensionsDir);
  } catch {
    return null;
  }

  // settings.json stores the theme id; older/simple themes only have a label. Prefer an id match.
  let byLabel: string | null = null;
  for (const dir of dirs) {
    const pkg = await readJsonc(path.join(extensionsDir, dir, "package.json"));
    const themes = (pkg?.contributes as { themes?: { id?: string; label?: string; path?: string }[] } | undefined)?.themes;
    for (const t of themes ?? []) {
      if (!t.path) continue;
      const file = path.join(extensionsDir, dir, t.path);
      if (t.id === wanted) {
        const theme = await loadThemeFile(file);
        return theme ? { ...theme, name: wanted } : null;
      }
      if (!byLabel && t.label === wanted) byLabel = file;
    }
  }
  if (!byLabel) return null;
  const theme = await loadThemeFile(byLabel);
  return theme ? { ...theme, name: wanted } : null;
}
