// Link handled by the Claude Code VS Code extension: opens a Claude tab with the prompt pre-filled
// (never auto-submitted). With `session` it returns to that conversation if it belongs to the open workspace.
/** Usable value, i.e. not blank and not an unsubstituted ${...} skill placeholder. */
export function realValue(v: string | undefined): string | undefined {
  return v && v.trim() && !v.includes("${") ? v.trim() : undefined;
}

/**
 * Opening a folder makes VS Code focus the window that already has it open. The Claude link then lands
 * in that window (VS Code routes vscode:// links to the most recently focused window).
 */
export function vscodeFolderUrl(folder: string): string {
  const posix = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  const withSlash = posix.startsWith("/") ? posix : `/${posix}`;
  return `vscode://file${encodeURI(withSlash).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

export function claudeOpenUrl(prompt: string, sessionId?: string): string {
  let url = `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
  const id = realValue(sessionId);
  if (id) url += `&session=${encodeURIComponent(id)}`;
  return url;
}
