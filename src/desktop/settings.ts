import { promises as fs } from "node:fs";
import path from "node:path";

export interface DesktopSettings {
  openAtLogin: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = { openAtLogin: false };

/** Missing, unreadable or malformed file → defaults (the app must always start). */
export async function loadSettings(file: string): Promise<DesktopSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DesktopSettings>;
    return { openAtLogin: typeof parsed.openAtLogin === "boolean" ? parsed.openAtLogin : DEFAULT_SETTINGS.openAtLogin };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(file: string, s: DesktopSettings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(s, null, 2), "utf8");
}
