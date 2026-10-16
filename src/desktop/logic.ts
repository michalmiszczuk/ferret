// Pure helpers for the Electron main process. No Electron imports, so they are unit-testable.
import type { Severity } from "../shared/schema";

export const PROTOCOL = "review-app";
export const APP_ID = "com.reviewapp.desktop";

/** The review-app:// link Windows passes on argv (cold start or second instance). */
export function findProtocolUrl(argv: string[]): string | undefined {
  return argv.find((a) => a.toLowerCase().startsWith(`${PROTOCOL}://`));
}

/** Login-item launches pass --hidden; a review-app:// launch always shows the window. */
export function startedHidden(argv: string[]): boolean {
  return argv.includes("--hidden") && !findProtocolUrl(argv);
}

/** True only for pages of our own local server — the only thing the window may show. */
export function isAppUrl(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === String(port);
  } catch {
    return false;
  }
}

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "vscode:"]);

/** Links we are willing to hand to the OS (browser, VS Code). */
export function isSafeExternal(url: string): boolean {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function reviewNotificationText(counts: Record<Severity, number>): string {
  return `🔴 ${counts.critical} · 🟠 ${counts.high} · 🟡 ${counts.medium} · 🟢 ${counts.low}`;
}

/** Files listed in electron-builder's asarUnpack live next to app.asar in app.asar.unpacked. */
export function unpackedPath(p: string): string {
  return p.replace(/app\.asar(?=[\\/]|$)/, "app.asar.unpacked");
}

/**
 * "Start with Windows" only means something for the installed app (a dev run would register bare
 * electron.exe). The installed app re-applies the saved choice on every start so Windows can't drift.
 */
export function loginItemPlan(isPackaged: boolean, saved: boolean): { enabled: boolean; checked: boolean; applyOnStart: boolean } {
  return isPackaged
    ? { enabled: true, checked: saved, applyOnStart: true }
    : { enabled: false, checked: false, applyOnStart: false };
}

/** A dev run must not steal review-app:// from the installed app unless explicitly asked to. */
export function shouldRegisterProtocol(isDevRun: boolean, env: Record<string, string | undefined>): boolean {
  return !isDevRun || env.REVIEW_APP_DEV_PROTOCOL === "1";
}

/** Closing the window hides it to the tray, except when quitting or when Windows ends the session. */
export function closeAction(s: { quitting: boolean; sessionEnding: boolean }): "hide" | "close" {
  return s.quitting || s.sessionEnding ? "close" : "hide";
}

export function startupErrorMessage(err: unknown, port: number): string {
  if ((err as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
    return `Port ${port} is in use. Is Ferret already running from a terminal? Close it and start the app again.`;
  }
  return err instanceof Error ? err.message : String(err);
}
