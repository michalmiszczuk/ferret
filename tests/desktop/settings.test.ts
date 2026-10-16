import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../src/desktop/settings";
import { tmpDir } from "../helpers";

describe("desktop settings", () => {
  it("defaults to Start with Windows OFF when the file is missing", async () => {
    const dir = await tmpDir("review-app-settings-");
    expect(await loadSettings(path.join(dir, "desktop.json"))).toEqual({ openAtLogin: false });
    expect(DEFAULT_SETTINGS).toEqual({ openAtLogin: false });
  });

  it("falls back to defaults for corrupt or wrongly-typed files", async () => {
    const dir = await tmpDir("review-app-settings-");
    const file = path.join(dir, "desktop.json");
    await fs.writeFile(file, "{ nope");
    expect(await loadSettings(file)).toEqual({ openAtLogin: false });
    await fs.writeFile(file, JSON.stringify({ openAtLogin: "yes" }));
    expect(await loadSettings(file)).toEqual({ openAtLogin: false });
  });

  it("round-trips and creates the parent directory", async () => {
    const dir = await tmpDir("review-app-settings-");
    const file = path.join(dir, "nested", "desktop.json");
    await saveSettings(file, { openAtLogin: true });
    expect(await loadSettings(file)).toEqual({ openAtLogin: true });
  });
});
