# review-app Desktop (Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing review-app server and UI in an Electron app for Windows. It gets its own window, a tray icon, single instance, a `review-app://` launch link and an unsigned NSIS installer, and is structured so a Mac build can be added later.

**Architecture:** A new Electron main process (`src/desktop/main.ts`) calls the unchanged v1 `startServer()` in-process on `127.0.0.1:4477` and opens a `BrowserWindow` on it. All logic that can be pure (argv parsing, URL rules, startup error text, settings file, icon PNG) lives in small Electron-free modules with unit tests. `main.ts` is thin glue. tsup bundles the main process to CommonJS. electron-builder packages it.

**Tech Stack:** Electron 33, electron-builder 25 (NSIS), plus the existing Node 20+/TypeScript/Express/MCP SDK/React/Vite/tsup/Vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-desktop-app-design.md` (builds on `docs/superpowers/specs/2026-10-15-review-app-design.md`)

## Global Constraints

- The v1 server, UI, MCP tools and CLI stay behaviorally unchanged. All existing tests (92) must keep passing.
- Port `4477`, host `127.0.0.1`. The data dir is shared with the CLI: `~/.review-app/` (`REVIEW_APP_HOME` override). Desktop settings go in `~/.review-app/desktop.json` as `{ "openAtLogin": boolean }`, default `false`.
- **Start with Windows is OFF by default.** The tray checkbox toggles it with `args: ["--hidden"]`.
- Protocol scheme: `review-app`. Launch link: `review-app://open`.
- App id `com.reviewapp.desktop`, product name `review-app`.
- Window security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload. The window never navigates away from `http://127.0.0.1:4477`. External links open via the OS only for `http:`, `https:` and `vscode:`.
- Closing the window hides it (tray). Only tray → Quit exits.
- Every new review shows and focuses the window. If the window was hidden, a notification is also shown.
- Port busy at startup → error dialog with exactly: `Port 4477 is in use. Is review-app already running from a terminal? Close it and start the app again.`, then quit.
- Unsigned NSIS installer, per-user (`oneClick: true`, `perMachine: false`), output in `release/`.
- Dark theme only. UI *behavior* is unchanged; the only UI change is Task 6's Figma-style visual refresh (spec "Visual refresh").
- **Commits:** the user commits by hand. At each "Commit checkpoint", stop and tell the user which files are ready plus a one-line message. Never run `git commit`.

## Review Focus

1. **Packaged paths.** Inside the installed app, the UI and skills live in `app.asar`. Express static serving and skill copying must read from `app.asar.unpacked`, otherwise the window is blank or "Install Claude integration" fails. Pinned by `unpackedPath` tests in Task 1, plus the installed-app check in Task 5.
2. **Links in the UI.** Clicking "Open in VS Code" or a markdown link must open the OS handler and never navigate the app window away. `javascript:`/`file:` links must not be opened. Pinned by `isAppUrl`/`isSafeExternal` tests in Task 1.
3. **Launch arguments.** A cold start from the login item (`--hidden`) stays hidden, but a cold start via `review-app://open` must show the window even if `--hidden` is also present. Pinned by `startedHidden`/`findProtocolUrl` tests in Task 1.
4. **Missing or corrupt `desktop.json`.** The app must still start, with Start with Windows off. Pinned by `loadSettings` tests in Task 2.
5. **Port already taken** (terminal `review-app start` still running) → the exact clear message, not a crash. Pinned by the `startupErrorMessage` tests in Task 1.

---

## File Structure

```
src/desktop/
  logic.ts        # pure: PROTOCOL, APP_ID, findProtocolUrl, startedHidden, isAppUrl, isSafeExternal,
                  #       reviewNotificationText, unpackedPath, startupErrorMessage
  settings.ts     # loadSettings / saveSettings for desktop.json
  icon.ts         # makeIconPng(size): Buffer (dependency-free PNG encoder)
  main.ts         # Electron glue (window, tray, protocol, notifications, login item, integration)
src/cli/setup.ts  # + registrationMessage() (shared by CLI and desktop)
src/cli/index.ts  # uses registrationMessage()
skills/ai-review/SKILL.md, skills/apply-review/SKILL.md   # + launch-the-app rule
scripts/make-icon.ts       # writes build/icon.png
build/icon.png             # generated, committed
electron-builder.yml
tsup.config.ts             # + desktop/main CJS entry
package.json               # + main, description, scripts, electron deps
tests/desktop/logic.test.ts, tests/desktop/settings.test.ts, tests/desktop/icon.test.ts
tests/cli/setup.test.ts    # + registrationMessage + launch-rule assertions
```

---

### Task 1: Pure desktop logic

**Files:**
- Create: `src/desktop/logic.ts`
- Test: `tests/desktop/logic.test.ts`

**Interfaces:**
- Consumes: `Severity` from `src/shared/schema.ts`
- Produces:
  - `PROTOCOL = "review-app"`, `APP_ID = "com.reviewapp.desktop"`
  - `findProtocolUrl(argv: string[]): string | undefined`
  - `startedHidden(argv: string[]): boolean`
  - `isAppUrl(url: string, port: number): boolean`
  - `isSafeExternal(url: string): boolean`
  - `reviewNotificationText(counts: Record<Severity, number>): string`
  - `unpackedPath(p: string): string`
  - `startupErrorMessage(err: unknown, port: number): string`

- [ ] **Step 1: Write the failing test** `tests/desktop/logic.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  findProtocolUrl, isAppUrl, isSafeExternal, reviewNotificationText, startedHidden, startupErrorMessage, unpackedPath,
} from "../../src/desktop/logic";

describe("findProtocolUrl", () => {
  it("finds the review-app link among Windows second-instance args (case-insensitive)", () => {
    const argv = ["C:\\Apps\\review-app.exe", "--allow-file-access-from-files", "REVIEW-APP://open"];
    expect(findProtocolUrl(argv)).toBe("REVIEW-APP://open");
  });

  it("returns undefined when absent", () => {
    expect(findProtocolUrl(["review-app.exe", "--hidden"])).toBeUndefined();
  });
});

describe("startedHidden", () => {
  it("is true for the login-item launch", () => {
    expect(startedHidden(["review-app.exe", "--hidden"])).toBe(true);
  });

  it("is false for a normal launch", () => {
    expect(startedHidden(["review-app.exe"])).toBe(false);
  });

  it("is false when launched via review-app:// even if --hidden is present", () => {
    expect(startedHidden(["review-app.exe", "--hidden", "review-app://open"])).toBe(false);
  });
});

describe("isAppUrl", () => {
  it("accepts the app's own origin on the right port", () => {
    expect(isAppUrl("http://127.0.0.1:4477/r/r_abc123", 4477)).toBe(true);
    expect(isAppUrl("http://localhost:4477/", 4477)).toBe(true);
  });

  it("rejects other ports, hosts and schemes", () => {
    expect(isAppUrl("http://127.0.0.1:5173/", 4477)).toBe(false);
    expect(isAppUrl("https://127.0.0.1:4477/", 4477)).toBe(false);
    expect(isAppUrl("http://evil.example:4477/", 4477)).toBe(false);
    expect(isAppUrl("vscode://file/C:/a.ts:1", 4477)).toBe(false);
    expect(isAppUrl("not a url", 4477)).toBe(false);
  });
});

describe("isSafeExternal", () => {
  it("allows http, https and vscode links", () => {
    expect(isSafeExternal("https://github.com")).toBe(true);
    expect(isSafeExternal("http://example.com")).toBe(true);
    expect(isSafeExternal("vscode://file/C:/Users/Micha%C5%82/a.ts:3")).toBe(true);
  });

  it("refuses javascript:, file: and garbage", () => {
    expect(isSafeExternal("javascript:alert(1)")).toBe(false);
    expect(isSafeExternal("file:///C:/Windows/system32/calc.exe")).toBe(false);
    expect(isSafeExternal("::::")).toBe(false);
  });
});

describe("reviewNotificationText", () => {
  it("formats the severity counts", () => {
    expect(reviewNotificationText({ critical: 2, high: 3, medium: 4, low: 1 })).toBe("🔴 2 · 🟠 3 · 🟡 4 · 🟢 1");
  });
});

describe("unpackedPath", () => {
  it("redirects paths inside app.asar to app.asar.unpacked (Windows and POSIX separators)", () => {
    expect(unpackedPath("C:\\Apps\\review-app\\resources\\app.asar\\dist\\ui")).toBe(
      "C:\\Apps\\review-app\\resources\\app.asar.unpacked\\dist\\ui",
    );
    expect(unpackedPath("/Applications/review-app.app/Contents/Resources/app.asar/skills")).toBe(
      "/Applications/review-app.app/Contents/Resources/app.asar.unpacked/skills",
    );
  });

  it("leaves dev paths and already-unpacked paths alone", () => {
    expect(unpackedPath("C:\\Users\\me\\Code\\review-app\\dist\\ui")).toBe("C:\\Users\\me\\Code\\review-app\\dist\\ui");
    expect(unpackedPath("C:\\x\\app.asar.unpacked\\skills")).toBe("C:\\x\\app.asar.unpacked\\skills");
  });
});

describe("startupErrorMessage", () => {
  it("explains a busy port", () => {
    const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    expect(startupErrorMessage(err, 4477)).toBe(
      "Port 4477 is in use. Is review-app already running from a terminal? Close it and start the app again.",
    );
  });

  it("passes other errors through", () => {
    expect(startupErrorMessage(new Error("disk on fire"), 4477)).toBe("disk on fire");
    expect(startupErrorMessage("weird", 4477)).toBe("weird");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/desktop/logic.test.ts`
Expected: FAIL. Cannot find module `../../src/desktop/logic`.

- [ ] **Step 3: Implement `src/desktop/logic.ts`**

```ts
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

export function startupErrorMessage(err: unknown, port: number): string {
  if ((err as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
    return `Port ${port} is in use. Is review-app already running from a terminal? Close it and start the app again.`;
  }
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/desktop/logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

Files: `src/desktop/logic.ts tests/desktop/logic.test.ts`. Suggested message: `Add desktop launch and link rules`

---

### Task 2: Desktop settings file and app icon

**Files:**
- Create: `src/desktop/settings.ts`, `src/desktop/icon.ts`, `scripts/make-icon.ts`, `build/icon.png` (generated)
- Modify: `package.json` (add `"icon"` script)
- Test: `tests/desktop/settings.test.ts`, `tests/desktop/icon.test.ts`

**Interfaces:**
- Consumes: `tmpDir` from `tests/helpers.ts`
- Produces:
  - `interface DesktopSettings { openAtLogin: boolean }`, `DEFAULT_SETTINGS: DesktopSettings`
  - `loadSettings(file: string): Promise<DesktopSettings>`, `saveSettings(file: string, s: DesktopSettings): Promise<void>`
  - `makeIconPng(size: number): Buffer` (RGBA PNG)

- [ ] **Step 1: Write the failing tests**

`tests/desktop/settings.test.ts`:

```ts
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
```

`tests/desktop/icon.test.ts`:

```ts
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeIconPng } from "../../src/desktop/icon";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal PNG reader for the test: returns width, height and the concatenated, inflated IDAT data. */
function readPng(buf: Buffer) {
  expect(buf.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  const types: string[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    types.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8); // bit depth
      expect(data[9]).toBe(6); // RGBA
    }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  return { width, height, types, raw: inflateSync(Buffer.concat(idat)) };
}

describe("makeIconPng", () => {
  it.each([16, 32, 256])("produces a valid %ipx RGBA PNG", (size) => {
    const png = readPng(makeIconPng(size));
    expect(png.width).toBe(size);
    expect(png.height).toBe(size);
    expect(png.types).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(png.raw.length).toBe((size * 4 + 1) * size);
  });

  it("paints a dark background corner and a red top bar", () => {
    const size = 64;
    const { raw } = readPng(makeIconPng(size));
    const px = (x: number, y: number) => {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    };
    expect(px(0, 0)).toEqual([13, 17, 23, 255]);
    expect(px(Math.round(size * 0.25), Math.round(size * 0.2))).toEqual([248, 81, 73, 255]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/desktop`
Expected: FAIL. Cannot find modules `settings` / `icon` (the logic tests from Task 1 still pass).

- [ ] **Step 3: Implement `src/desktop/settings.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/desktop/icon.ts`**

```ts
import { deflateSync } from "node:zlib";

// Dark square with four severity-colored bars (critical → low), matching the app's palette.
const BG: [number, number, number] = [13, 17, 23];
const BARS: [number, number, number][] = [
  [248, 81, 73],
  [240, 136, 62],
  [210, 153, 34],
  [63, 185, 80],
];
const BAR_WIDTHS = [1, 0.8, 0.62, 0.45];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Renders the app icon as an RGBA PNG of the given size. Dependency-free so main and build scripts share it. */
export function makeIconPng(size: number): Buffer {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const pad = Math.round(size * 0.16);
  const gap = Math.max(1, Math.round(size * 0.06));
  const barH = (size - 2 * pad - 3 * gap) / 4;
  const inner = size - 2 * pad;

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    const yy = y - pad;
    const bar = Math.floor(yy / (barH + gap));
    const inBar = yy >= 0 && bar < 4 && yy - bar * (barH + gap) < barH;
    for (let x = 0; x < size; x++) {
      const color = inBar && x >= pad && x < pad + inner * BAR_WIDTHS[bar] ? BARS[bar] : BG;
      const i = y * stride + 1 + x * 4;
      raw[i] = color[0];
      raw[i + 1] = color[1];
      raw[i + 2] = color[2];
      raw[i + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/desktop`
Expected: PASS (logic, settings and icon suites).

- [ ] **Step 6: Generate `build/icon.png`**

Create `scripts/make-icon.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeIconPng } from "../src/desktop/icon";

const out = path.join(process.cwd(), "build", "icon.png");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, makeIconPng(512));
console.log(`Wrote ${out}`);
```

Add to `package.json` `scripts`: `"icon": "tsx scripts/make-icon.ts"`.

Run: `npm run icon`
Expected: `Wrote …\build\icon.png`. Open the file and check it shows four colored bars (red, orange, yellow, green) on a dark square.

- [ ] **Step 7: Commit checkpoint**

Files: `src/desktop/settings.ts src/desktop/icon.ts scripts/make-icon.ts build/icon.png package.json tests/desktop`. Suggested message: `Add desktop settings and icon`

---

### Task 3: Shared registration message and the launch-the-app rule in the skills

**Files:**
- Modify: `src/cli/setup.ts` (add `registrationMessage`), `src/cli/index.ts` (use it)
- Modify: `skills/ai-review/SKILL.md`, `skills/apply-review/SKILL.md`
- Test: `tests/cli/setup.test.ts` (add cases)

**Interfaces:**
- Consumes: `registerMcp(url): Promise<{ ok: boolean; output: string }>` (existing)
- Produces: `registrationMessage(res: { ok: boolean; output: string }, url: string): string`, used by the CLI and by `main.ts` in Task 4

- [ ] **Step 1: Write the failing tests.** Append to `tests/cli/setup.test.ts`, and add `registrationMessage` to its existing import from `../../src/cli/setup`.

```ts
describe("registrationMessage", () => {
  const url = "http://127.0.0.1:4477/mcp";

  it("confirms success", () => {
    expect(registrationMessage({ ok: true, output: "" }, url)).toBe(
      "Registered MCP server 'review-app' with Claude Code (user scope).",
    );
  });

  it("shows the error output and the manual command on failure", () => {
    const msg = registrationMessage({ ok: false, output: "MCP server review-app already exists" }, url);
    expect(msg).toContain("MCP server review-app already exists");
    expect(msg).toContain("If it is already registered, ignore this.");
    expect(msg).toContain(`claude mcp add --transport http --scope user review-app ${url}`);
  });

  it("handles a failure with no output (e.g. claude not on PATH)", () => {
    expect(registrationMessage({ ok: false, output: "" }, url)).toMatch(/^Could not register the MCP server automatically\./);
  });
});

describe("skills launch rule", () => {
  it.each(SKILL_NAMES)("%s tells Claude how to launch the desktop app and when to ask for /mcp", async (name) => {
    const text = await fs.readFile(path.join(pkgDir, "skills", name, "SKILL.md"), "utf8");
    expect(text).toContain("review-app://open");
    expect(text).toContain("Start-Process review-app://open");
    expect(text).toContain("/mcp");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli`
Expected: FAIL. `registrationMessage` is not exported, and the skills lack `review-app://open`.

- [ ] **Step 3: Add `registrationMessage` to `src/cli/setup.ts`** (append):

```ts
/** Human-readable result of registerMcp(), shared by `review-app setup` and the desktop tray action. */
export function registrationMessage(res: { ok: boolean; output: string }, url: string): string {
  if (res.ok) return "Registered MCP server 'review-app' with Claude Code (user scope).";
  return (
    `Could not register the MCP server automatically${res.output ? `:\n${res.output}` : "."}\n` +
    `If it is already registered, ignore this. Otherwise run:\n  claude mcp add --transport http --scope user review-app ${url}`
  );
}
```

- [ ] **Step 4: Use it in `src/cli/index.ts`.** Change the import to `import { findPackageDir, installSkills, registerMcp, registrationMessage } from "./setup";` and replace the `if (res.ok) { … } else { … }` block in the `setup` branch with:

```ts
    console.log(registrationMessage(res, url));
```

- [ ] **Step 5: Update `skills/ai-review/SKILL.md` §5.** Replace the bullet that starts `- If the \`review-app\` tool is unavailable or the connection fails:` with:

```markdown
- If the `review-app` tool is unavailable or the connection fails, the app is probably not running:
  1. Launch it. Windows (PowerShell): `Start-Process review-app://open`. Windows (Git Bash): `cmd //c start "" review-app://open`. macOS: `open review-app://open`.
  2. Wait about 5 seconds, then call `submit_review` once more.
  3. If it still fails, tell the user: "review-app is starting but Claude Code isn't connected to it yet. Run `/mcp`, reconnect `review-app`, then tell me to retry." If launching failed because the app isn't installed, say: "Start review-app (desktop app, or `review-app` in a terminal), then tell me to retry." Keep the findings and resubmit when asked.
```

- [ ] **Step 6: Update `skills/apply-review/SKILL.md`.** Insert a new step between steps 1 and 2 (and renumber the later steps 3→4 and 4→5):

```markdown
2. If the `review-app` tool is unavailable or the connection fails, the app is probably not running. Launch it (Windows PowerShell: `Start-Process review-app://open`; Windows Git Bash: `cmd //c start "" review-app://open`; macOS: `open review-app://open`), wait about 5 seconds and call `get_pending_actions` once more. If it still fails, tell the user to run `/mcp`, reconnect `review-app`, and tell you to retry.
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/cli`
Expected: PASS (all old and new setup tests).

- [ ] **Step 8: Commit checkpoint**

Files: `src/cli/setup.ts src/cli/index.ts skills tests/cli/setup.test.ts`. Suggested message: `Teach skills to launch the app`

---

### Task 4: Electron main process and dev launch

**Files:**
- Create: `src/desktop/main.ts`
- Modify: `tsup.config.ts`, `package.json` (`main`, `description`, scripts, devDeps)

**Interfaces:**
- Consumes: `startServer`, `defaultHome`, `RunningServer` (`src/server/index.ts`); `installSkills`, `registerMcp`, `registrationMessage` (`src/cli/setup.ts`); `countBySeverity` (`src/shared/findings.ts`); `StoreEvent` (`src/shared/api-types.ts`); everything from Task 1 `logic.ts`; `loadSettings`, `saveSettings`, `DesktopSettings` (Task 2); `makeIconPng` (Task 2)
- Produces: `dist/desktop/main.cjs` (Electron entry, `package.json` `"main"`), and scripts `desktop:dev`, `desktop:dist`

Electron glue is verified by typecheck, build and a manual dev run. Its decisions live in the unit-tested `logic.ts`, `settings.ts` and `icon.ts`.

- [ ] **Step 1: Install Electron**

Run: `npm install -D electron@^33 electron-builder@^25`
Expected: finishes without `ERR!`. The Electron binary downloads during postinstall.

- [ ] **Step 2: Update `package.json`.** Add top-level fields:

```json
  "description": "Local triage desk for AI code reviews",
  "main": "dist/desktop/main.cjs",
```

and these entries in `scripts`:

```json
    "desktop:dev": "npm run build && electron .",
    "desktop:dist": "npm run build && electron-builder --win"
```

- [ ] **Step 3: Replace `tsup.config.ts`** with two builds: the existing CLI (ESM), plus the Electron main (CJS):

```ts
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    outDir: "dist",
    clean: false, // dist/ui is produced by `vite build` first
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { "desktop/main": "src/desktop/main.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node20",
    outDir: "dist",
    clean: false,
    sourcemap: true,
    external: ["electron"],
    outExtension: () => ({ js: ".cjs" }),
  },
]);
```

- [ ] **Step 4: Create `src/desktop/main.ts`**

```ts
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray } from "electron";
import os from "node:os";
import path from "node:path";
import { installSkills, registerMcp, registrationMessage } from "../cli/setup";
import { defaultHome, startServer, type RunningServer } from "../server/index";
import type { StoreEvent } from "../shared/api-types";
import { countBySeverity } from "../shared/findings";
import { makeIconPng } from "./icon";
import {
  APP_ID, isAppUrl, isSafeExternal, PROTOCOL, reviewNotificationText, startedHidden, startupErrorMessage, unpackedPath,
} from "./logic";
import { loadSettings, saveSettings, type DesktopSettings } from "./settings";

const PORT = 4477;
const settingsFile = path.join(defaultHome(), "desktop.json");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: RunningServer | null = null;
let settings: DesktopSettings = { openAtLogin: false };
let quitting = false;

const icon = (size: number) => nativeImage.createFromBuffer(makeIconPng(size));

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function registerProtocol(): void {
  // In dev (`electron .`) Windows must be told to launch electron.exe with our app path.
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function createWindow(url: string, hidden: boolean): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: "review-app",
    backgroundColor: "#0d1117",
    icon: icon(256),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Links (Open in VS Code, markdown links) go to the OS; the window only ever shows our own UI.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isSafeExternal(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (isAppUrl(target, PORT)) return;
    e.preventDefault();
    if (isSafeExternal(target)) void shell.openExternal(target);
  });

  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.once("ready-to-show", () => {
    if (!hidden) showWindow();
  });
  void win.loadURL(url);
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "Open review-app", click: showWindow },
    { type: "separator" },
    {
      label: process.platform === "darwin" ? "Start at login" : "Start with Windows",
      type: "checkbox",
      checked: settings.openAtLogin,
      click: (item) => void setOpenAtLogin(item.checked),
    },
    { label: "Install Claude integration…", click: () => void installIntegration() },
    { type: "separator" },
    { label: "Quit", click: quit },
  ]);
}

function createTray(): void {
  tray = new Tray(icon(32).resize({ width: 16, height: 16 }));
  tray.setToolTip("review-app");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showWindow);
}

async function setOpenAtLogin(on: boolean): Promise<void> {
  settings = { ...settings, openAtLogin: on };
  // Only the installed app should register itself; in dev it would register bare electron.exe.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
  await saveSettings(settingsFile, settings);
  tray?.setContextMenu(buildTrayMenu());
}

async function installIntegration(): Promise<void> {
  try {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const dirs = await installSkills(unpackedPath(path.join(app.getAppPath(), "skills")), claudeHome);
    const url = `http://127.0.0.1:${PORT}/mcp`;
    const res = await registerMcp(url);
    await dialog.showMessageBox({
      type: res.ok ? "info" : "warning",
      title: "Claude integration",
      message: "Claude integration",
      detail: `Installed skills:\n${dirs.join("\n")}\n\n${registrationMessage(res, url)}\n\nStart a new Claude Code session to use /ai-review.`,
    });
  } catch (err) {
    dialog.showErrorBox("Claude integration failed", startupErrorMessage(err, PORT));
  }
}

function onStoreChange(e: StoreEvent): void {
  if (e.type !== "review-created" || !win || !server) return;
  const wasVisible = win.isVisible();
  showWindow();
  if (!wasVisible && Notification.isSupported()) {
    const review = server.store.get(e.reviewId);
    const n = new Notification({
      title: "New review",
      body: review ? reviewNotificationText(countBySeverity(review.findings)) : e.reviewId,
      icon: icon(64),
    });
    n.on("click", showWindow);
    n.show();
  }
}

async function start(): Promise<void> {
  settings = await loadSettings(settingsFile);
  try {
    server = await startServer({ port: PORT, uiDir: unpackedPath(path.join(app.getAppPath(), "dist", "ui")) });
  } catch (err) {
    dialog.showErrorBox("review-app could not start", startupErrorMessage(err, PORT));
    app.exit(1);
    return;
  }
  server.store.on("change", onStoreChange);
  createWindow(server.url, startedHidden(process.argv));
  createTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  registerProtocol();
  app.on("second-instance", () => showWindow()); // Start menu relaunch or review-app://open
  app.on("open-url", (e) => {
    // macOS delivers review-app:// here
    e.preventDefault();
    showWindow();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    // keep running in the tray
  });
  app.on("will-quit", () => {
    void server?.close();
  });
  void app.whenReady().then(start);
}
```

- [ ] **Step 5: Typecheck, test, build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: all suites PASS (the 92 existing tests plus the new desktop and setup tests).

Run: `npm run build`
Expected: `dist/ui/index.html`, `dist/cli.js` and `dist/desktop/main.cjs` exist.

- [ ] **Step 6: Dev launch check** (stop any terminal `review-app start` / `node dist/cli.js start` first)

Run: `npx electron .`
Expected:
- A "review-app" window with the dark UI and your existing reviews. No browser opens.
- A tray icon (colored bars) appears. Closing the window hides it, and clicking the tray icon brings it back.
- `npm run seed` in a second terminal → the window comes to the front showing the new review. Do it again with the window closed → a "New review" notification appears and the window shows.
- In PowerShell: `Start-Process review-app://open` with the window hidden → the window shows (the dev protocol registration works).
- Run `npx electron .` a second time → no second window; the first one is focused.
- Tray → Quit → the process exits, and `http://127.0.0.1:4477` no longer responds.
- With `node dist/cli.js start` running, `npx electron .` → the "Port 4477 is in use…" dialog appears, then it exits.

- [ ] **Step 7: Commit checkpoint**

Files: `src/desktop/main.ts tsup.config.ts package.json package-lock.json`. Suggested message: `Add Electron desktop shell`

---

### Task 5: Windows installer, manual check, README

**Files:**
- Create: `electron-builder.yml`
- Modify: `.gitignore` (add `release/`), `README.md`

**Interfaces:**
- Consumes: `package.json` `main`, `desktop:dist` script (Task 4); `build/icon.png` (Task 2)
- Produces: `release/review-app Setup 0.1.0.exe`

- [ ] **Step 1: Create `electron-builder.yml`**

```yaml
appId: com.reviewapp.desktop
productName: review-app
directories:
  output: release
  buildResources: build
files:
  - dist/**/*
  - skills/**/*
  - package.json
asarUnpack:
  - dist/ui/**
  - skills/**
protocols:
  - name: review-app
    schemes:
      - review-app
win:
  target: nsis
  icon: build/icon.png
nsis:
  oneClick: true
  perMachine: false
mac:
  target: dmg
  icon: build/icon.png
  category: public.app-category.developer-tools
```

Append `release/` to `.gitignore`.

- [ ] **Step 2: Build the installer**

Run: `npm run desktop:dist`
Expected: `release/review-app Setup 0.1.0.exe` exists. Warnings about missing code signing are expected.

- [ ] **Step 3: Check the packaged layout** (pins Review Focus 1)

Run: `Test-Path release/win-unpacked/resources/app.asar, release/win-unpacked/resources/app.asar.unpacked/dist/ui/index.html, release/win-unpacked/resources/app.asar.unpacked/skills/ai-review/SKILL.md`
Expected: three `True` results.

Run: `release/win-unpacked/review-app.exe` (with no other instance running).
Expected: the window shows the UI (not blank). That proves `unpackedPath` + `uiDir` work packaged. Quit from the tray.

- [ ] **Step 4: Update `README.md`.** Add after the title paragraph:

````markdown
## Desktop app (Windows)

```
npm install
npm run icon          # once, generates build/icon.png
npm run desktop:dist  # builds release/review-app Setup <version>.exe
```

Run the installer (unsigned: SmartScreen → "More info" → "Run anyway"). Then:
- Tray icon → **Install Claude integration…** (installs the skills + registers the MCP server)
- Closing the window keeps review-app running in the tray; tray → **Quit** exits
- Tray → **Start with Windows** (off by default) keeps it ready for Claude
- If review-app isn't running, `/ai-review` launches it via `review-app://open`

Dev run: `npm run desktop:dev`
````

- [ ] **Step 5: Manual Windows checklist, with the user.** This changes the user's machine and Claude config, so ask before starting.
1. Install `release/review-app Setup 0.1.0.exe`. The Start menu has "review-app".
2. Launch it. The window shows existing reviews. Close it → the tray icon remains. Launch again from the Start menu → the same window is focused, with no second one.
3. Tray → Install Claude integration… The dialog lists the two skill paths and the MCP registration result.
4. New Claude Code session in VS Code → `/ai-review` on a small change. The window comes forward, or a notification appears if it was hidden. "Open in VS Code" opens VS Code at the line.
5. **The connection check from spec §4.** Tray → Quit. Start a new Claude Code session (app not running) → `/ai-review`. Record what happens:
   - (a) Claude launches the app and the retry succeeds, or
   - (b) the tools stay unavailable until `/mcp` → reconnect.

   If (b) happens and Claude doesn't clearly ask for `/mcp`, adjust the step-3 wording in both skills and re-run `npx vitest run tests/cli`.
6. Tray → Start with Windows ✓ → sign out and in → the app runs in the tray with no window. Uncheck it.
7. Tray → Quit → `http://127.0.0.1:4477` stops responding. Uninstall via Settings → Apps → review-app.

- [ ] **Step 6: Commit checkpoint**

Files: `electron-builder.yml .gitignore README.md` (plus skill wording if Step 5.5 changed it). Suggested message: `Add Windows installer config`

---

### Task 6: Figma-style visual refresh

Runs before Task 5's installer build, so the installer ships the new look.

**Files:**
- Modify: `src/ui/styles.css` (full rewrite against the tokens below), `src/ui/main.tsx` (font import), `src/ui/components/FindingsList.tsx` (add an uppercase "Findings" section label above the list, the only markup change)
- Create: `scripts/screenshot.cjs` (dev-only Electron capture helper)
- Modify: `package.json` (dependency `@fontsource-variable/inter`, script `"screenshot"`)

**Interfaces:** none new. Class names used by components stay the same, so component tests are unaffected.

**Tokens (from spec "Visual refresh"):**

| Token | Value |
|---|---|
| `--bg` (canvas/code) | `#1e1e1e` |
| `--panel` | `#2c2c2c` |
| `--raised` / hover | `#383838` |
| `--border` | `#3d3d3d` (strong `#444444`) |
| `--text` / `--muted` / `--faint` | `#e6e6e6` / `#a3a3a3` / `#7a7a7a` |
| `--accent` / `--accent-tint` | `#14ae5c` / `rgba(20,174,92,.18)` |
| font | `"Inter Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`, base 12px, labels 11px/600/uppercase/0.04em |
| mono | `"JetBrains Mono", "Cascadia Code", Consolas, monospace`, 12px |
| radius | 6px controls, 8px cards |

- [ ] **Step 1:** `npm install @fontsource-variable/inter` and add `import "@fontsource-variable/inter";` as the first import in `src/ui/main.tsx`.
- [ ] **Step 2:** Rewrite `src/ui/styles.css` against the tokens, keeping every existing class name: compact 28–32px rows, the selected row with `--accent-tint` background, the primary "Send to Claude" button solid `--accent`, other buttons flat (`--raised` on hover), a 40px header on `--panel`, a 280px list pane, and 18px code line height.
- [ ] **Step 3:** In `FindingsList.tsx`, render `<div className="section-label">Findings</div>` directly above the active `<ul>`.
- [ ] **Step 4:** Create `scripts/screenshot.cjs`. Electron loads `http://127.0.0.1:4477` in a hidden 1400×900 window, waits for load plus 1.5s, `capturePage()`s to the path in `process.argv[2]`, and exits. Add the script `"screenshot": "electron scripts/screenshot.cjs"`.
- [ ] **Step 5:** Verify:
  - `npm test` → all pass (component tests use roles/text, not styles).
  - `npm run typecheck` clean.
  - `npm run build`.
  - With a server running and a seeded review, `npm run screenshot -- <scratch>/ui.png`, and view the PNG. Check: neutral grays (no blue tint), green selected row and primary button, small Inter text, the severity bars visible, and the comment card readable.
- [ ] **Step 6: Commit checkpoint.** Files: `src/ui package.json package-lock.json scripts/screenshot.cjs`. Suggested message: `Figma-style UI refresh`
