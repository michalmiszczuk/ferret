import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findVsCodeTheme, parseJsonc } from "../../src/server/vscode-theme";
import { makeRepo } from "../helpers";

/** A fake VS Code profile: User/settings.json + extensions/<ext>/package.json + theme files. */
async function makeVsCode(colorTheme: string | null) {
  const root = await makeRepo({
    "User/settings.json": colorTheme
      ? `{\n  // my settings\n  "editor.fontSize": 13,\n  "workbench.colorTheme": "${colorTheme}", /* trailing */\n}\n`
      : "{}",
    "extensions/teabyii.ayu-1.4.1/package.json": JSON.stringify({
      contributes: {
        themes: [
          { id: "Ayu Mirage Bordered", label: "Ayu Mirage", path: "./ayu-mirage.json" },
          { id: "Ayu Mirage", label: "Ayu Mirage Unbordered", path: "./ayu-mirage-unbordered.json" },
        ],
      },
    }),
    "extensions/teabyii.ayu-1.4.1/ayu-mirage.json":
      '{ "name": "Ayu Mirage Bordered", "colors": { "editor.background": "#1f2430" }, "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#ffad66" } }] }',
    // JSONC with a URL in a string (must not be treated as a comment) and a trailing comma
    "extensions/teabyii.ayu-1.4.1/ayu-mirage-unbordered.json":
      '{\n  // generated\n  "name": "Ayu Mirage",\n  "$schema": "vscode://schemas/color-theme",\n  "colors": { "editor.background": "#1f2430", },\n  "tokenColors": [{ "scope": "string", "settings": { "foreground": "#d5ff80" } }],\n}',
    "extensions/other.child-1.0.0/package.json": JSON.stringify({
      contributes: { themes: [{ id: "Child", label: "Child Theme", path: "./themes/child.json" }] },
    }),
    "extensions/other.child-1.0.0/themes/child.json":
      '{ "include": "./base.json", "colors": { "editor.foreground": "#ffffff" }, "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#777777" } }] }',
    "extensions/other.child-1.0.0/themes/base.json":
      '{ "colors": { "editor.background": "#000000", "editor.foreground": "#cccccc" }, "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#ff0000" } }] }',
  });
  return { settingsPath: path.join(root, "User", "settings.json"), extensionsDir: path.join(root, "extensions") };
}

describe("parseJsonc", () => {
  it("strips comments and trailing commas but keeps // inside strings", () => {
    expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }')).toEqual({ a: "http://x", b: [1, 2] });
  });
});

describe("findVsCodeTheme", () => {
  it("finds the theme by its id (what settings.json stores) and returns it with VS Code's name", async () => {
    const theme = await findVsCodeTheme(await makeVsCode("Ayu Mirage"));
    expect(theme?.name).toBe("Ayu Mirage");
    expect(theme?.colors?.["editor.background"]).toBe("#1f2430");
    expect(theme?.tokenColors).toEqual([{ scope: "string", settings: { foreground: "#d5ff80" } }]);
  });

  it("falls back to matching the label", async () => {
    const theme = await findVsCodeTheme(await makeVsCode("Child Theme"));
    expect(theme?.colors?.["editor.foreground"]).toBe("#ffffff");
  });

  it("merges an included base theme (child wins on conflicts)", async () => {
    const theme = await findVsCodeTheme(await makeVsCode("Child"));
    expect(theme?.colors).toEqual({ "editor.background": "#000000", "editor.foreground": "#ffffff" });
    expect(theme?.tokenColors).toEqual([
      { scope: "keyword", settings: { foreground: "#ff0000" } },
      { scope: "comment", settings: { foreground: "#777777" } },
    ]);
  });

  it("returns null for built-in or unknown themes and when no theme is set", async () => {
    expect(await findVsCodeTheme(await makeVsCode("Default Dark Modern"))).toBeNull();
    expect(await findVsCodeTheme(await makeVsCode(null))).toBeNull();
    expect(await findVsCodeTheme({ settingsPath: "Z:/nope/settings.json", extensionsDir: "Z:/nope" })).toBeNull();
  });
});
