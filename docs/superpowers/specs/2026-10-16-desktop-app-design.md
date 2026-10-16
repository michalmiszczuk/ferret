# review-app Desktop (Electron) — Design Spec

**Date:** 2026-10-16
**Status:** Draft for review
**Owner:** Michał Miszczuk
**Builds on:** `docs/superpowers/specs/2026-10-15-review-app-design.md` (v1: local server + MCP + web UI)

## 1. Purpose

v1 runs from a terminal (`review-app start`) and is used in a browser tab. The user wants a **real desktop app**: its own window and taskbar icon, no browser, no terminal.

- **Windows now.** Mac later, without rework.
- **Just for the user.** Unsigned builds are acceptable.
- Keeps running in the tray when the window is closed, and **Claude Code can launch it** if it isn't running.

### Success criteria

1. Installing `review-app Setup <version>.exe` gives a Start menu entry. Launching it opens a window showing the existing review UI, with no browser and no terminal.
2. Closing the window leaves the app running in the tray. `/ai-review` from Claude Code still lands in the app, and the window comes to the front.
3. When the app isn't running, `/ai-review` can launch it via `review-app://open` and then submit.
4. Tray → "Install Claude integration" installs the skills and registers the MCP server, the same as `review-app setup`.
5. All v1 behavior (UI, MCP tools, CLI) is unchanged. All existing tests still pass.

### Non-goals (this phase)

Mac build, code signing / notarization, auto-update, light theme, changes to the review UI's behavior.

### Visual refresh (added 2026-10-16)

The user wants the UI to look modern, "like Figma": small font aesthetics. This is a visual-only change; behavior and markup roles stay the same.

- **Palette (Figma UI3 dark):** canvas `#1e1e1e`, panels `#2c2c2c`, raised `#383838`, borders `#444444` / `#383838`, text `#e6e6e6`, muted `#a3a3a3`. Accent green `#14ae5c` for primary buttons and the selected row (selected row = green tint). Severity colors are unchanged.
- **Type:** Inter (bundled via `@fontsource-variable/inter`, works offline), with `Segoe UI Variable`/system fallback. UI text 11–12px, small uppercase section labels (11px, semibold, letter-spaced, muted), code 12px monospace.
- **Shape:** compact rows, 6px radius on controls, 8px on cards, 1px subtle borders, flat buttons without heavy fills except the primary action.

## 2. Architecture

A new Electron main process **wraps the unchanged v1 server and UI**.

```
review-app.exe (Electron)
 ├─ main process (src/desktop/main.ts)
 │   ├─ startServer({ port: 4477, uiDir }) ← v1 server, in-process (MCP + API + UI)
 │   ├─ BrowserWindow → http://127.0.0.1:4477
 │   ├─ Tray: Open · Start with Windows ✓ · Install Claude integration · Quit
 │   └─ review-app:// protocol handler + single-instance lock
 └─ renderer = the v1 React UI (no changes, talks HTTP to the same server)
```

| Unit | Responsibility |
|---|---|
| `src/desktop/main.ts` | Electron lifecycle: single-instance lock, start server, window, tray, protocol, notifications, login item. Glue only. |
| `src/desktop/logic.ts` | Pure, unit-tested helpers: protocol URL from argv, "started hidden?" from argv, in-app vs external URL, notification text. No Electron imports. |
| `src/desktop/settings.ts` | Reads/writes `~/.review-app/desktop.json` (`{ openAtLogin }`, default `false`). |
| `src/server/*`, `src/ui/*`, `src/cli/setup.ts` | Reused as they are. `installSkills` / `registerMcp` are called from the tray. |

- The data directory is shared with the CLI: `~/.review-app/` (reviews + `desktop.json`).
- The window loads the UI over HTTP from the in-process server, so the UI code is identical in browser and app.

## 3. Behavior

| Situation | Behavior |
|---|---|
| App launched (Start menu, shortcut) | Acquire the single-instance lock, start the server, show the window. |
| Launched with `--hidden` (login item) | Start the server and tray only. No window until it is opened. |
| Second launch / `review-app://…` while running | No second instance. The running app shows and focuses its window. |
| Window close button | Hides the window. The app stays in the tray. |
| Tray click / tray "Open" | Show and focus the window. |
| Tray "Quit" | Close the server and exit. |
| A new review is created (store `review-created` event) | Show and focus the window. If the window was hidden, also show a Windows notification "New review: 🔴 2 · 🟠 3 · 🟡 4 · 🟢 1". Clicking it focuses the window. |
| Link clicked in the UI (`vscode://`, `https://…`) | Opened with the OS (`shell.openExternal`). The window never navigates away from `http://127.0.0.1:4477`. New windows are denied. |
| Port 4477 busy at startup | Error dialog: "Port 4477 is in use. Is review-app already running from a terminal? Close it and start the app again." Then quit. |
| Server fails to start for another reason | Error dialog with the message, then quit. |

**Start with Windows.** **Off by default.** The tray checkbox toggles it (`app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })`), and the choice is persisted in `desktop.json`. When it is off, Claude launching the app (§4) is how the app gets started.

**Security.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload script. The renderer is the same web UI as in a browser.

## 4. Claude integration

### Tray → "Install Claude integration"

Runs `installSkills(<app skills dir>, <claude home>)` and then `registerMcp("http://127.0.0.1:4477/mcp")`. A dialog shows the result: the installed paths, plus either "registered" or the manual `claude mcp add …` command with the error output (for example "already registered", or `claude` not on PATH).

### Launching from Claude

`skills/ai-review/SKILL.md` §5 gets a launch step. If the `review-app` tool is unavailable or the connection fails:

1. Launch the app: Windows `cmd /c start "" review-app://open`, Mac `open review-app://open`.
2. Wait about 5 seconds and retry `submit_review` once.
3. If it still fails, tell the user: "review-app is starting but Claude Code isn't connected to it yet. Run `/mcp` and reconnect `review-app`, then tell me to retry." Keep the findings.

`/apply-review` gets the same rule for `get_pending_actions`.

**Known risk, verified in the first implementation task.** Claude Code may connect to MCP servers only when a session starts. If the app was down at that moment, the tools may be missing for the session even after launch. That is why step 3 exists. Turning on "Start with Windows" avoids the problem entirely. The real behavior is checked together with the user during the manual Windows test (it needs the user's Claude Code config and a live session), and the skill wording is adjusted to match.

## 5. Packaging

- **electron-builder.** `npm run desktop:dist` builds the UI (Vite), the main process (tsup → `dist/desktop/main.cjs`), and an NSIS installer in `release/`.
  - NSIS: `oneClick: true`, `perMachine: false` (installs to `%LOCALAPPDATA%\Programs\review-app`, no admin), Start menu shortcut.
  - `protocols: [{ name: "review-app", schemes: ["review-app"] }]` registers `review-app://`. In dev, `app.setAsDefaultProtocolClient` is called at startup.
  - `dist/ui/**` and `skills/**` are `asarUnpack`ed, so Express static serving and skill copying read plain files.
  - The installer is unsigned. On first run SmartScreen asks "More info → Run anyway". This is acceptable for personal use.
- **Icon.** One generated icon (four severity-colored bars on a dark square) in `build/icon.png` (512 px), used for the window, tray and installer. electron-builder derives `.ico`.
- **Mac later.** Add a `mac` target (dmg) to the config, and handle the `open-url` event (already in `main.ts`). No other code changes are expected.
- The CLI (`review-app start|setup`) and `npm run dev:server` keep working, using the same server and data directory.

## 6. Testing

- **Unit (Vitest)** for `src/desktop/logic.ts`:
  - `findProtocolUrl(argv)`: finds `review-app://…` among Windows second-instance args, and returns `undefined` when absent.
  - `startedHidden(argv)`.
  - `isAppUrl(url, port)`: true only for `http://127.0.0.1:<port>` and `http://localhost:<port>` paths. False for `vscode://`, other ports and other hosts.
  - `reviewNotificationText(counts)`.
- **Unit** for `settings.ts`: defaults when the file is missing or corrupt, and a write→read round trip.
- **Existing suite** stays green (92 tests). `npm run typecheck` is clean.
- **Manual Windows checklist:** install from `release/` → launch → close to tray → relaunch focuses (no second window) → `start review-app://open` focuses → `/ai-review` lands with the window brought forward / notification → "Open in VS Code" opens VS Code → "Install Claude integration" dialog → toggle "Start with Windows" and check after re-login → Quit exits (port free) → uninstall via Windows Settings.

## 7. Future

Mac `.dmg` (and later signing/notarization), auto-update (electron-updater), sharing an installer with teammates (needs signing).
