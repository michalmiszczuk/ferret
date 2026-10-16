// Link handled by the Claude Code VS Code extension: opens a Claude tab with the prompt pre-filled
// (never auto-submitted). With `session` it returns to that conversation if it belongs to the open workspace.
export function claudeOpenUrl(prompt: string, sessionId?: string): string {
  let url = `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
  // Skip blanks and an unsubstituted ${CLAUDE_SESSION_ID} placeholder.
  if (sessionId && sessionId.trim() && !sessionId.includes("${")) url += `&session=${encodeURIComponent(sessionId.trim())}`;
  return url;
}
