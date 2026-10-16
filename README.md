# Ferret 🦦

Ferret out bugs: a local triage desk for AI code reviews. Claude Code sends findings in, you triage them (🔴 → 🟢, code with inline comments), and Claude fixes the ones you pick.

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

Dev run: `npm run desktop:dev`. Screenshot of the running UI: `npm run screenshot -- out.png`. A dev run leaves `review-app://` pointing at the installed app; set `REVIEW_APP_DEV_PROTOCOL=1` to make the dev build own it instead.

If `desktop:dist` fails on Windows with "Cannot create symbolic link" (electron-builder's signing-tools archive contains macOS symlinks), either enable Windows Developer Mode, or extract `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<n>.7z` into `…\winCodeSign\winCodeSign-2.6.0` with `node_modules\7zip-bin\win\x64\7za.exe x` (the two macOS link errors are harmless).

## Terminal version

### Install (once)

```
npm install
npm run build
npm link            # puts `review-app` on your PATH
review-app setup    # installs /ai-review + /apply-review skills, registers the MCP server
```

### Use

1. Start the app: `review-app`, then open http://127.0.0.1:4477
2. In Claude Code (VS Code): `/ai-review` (uncommitted changes) or `/ai-review src/auth/` (files or folders)
3. Triage in the app: `j`/`k` move · `f` fix · `d` dismiss · `n` note to Claude
4. Click **Send N to Claude**, then paste (`/apply-review r_…`) into Claude
5. Watch the findings turn ✅ as Claude fixes them

Reviews are stored in `~/.review-app/reviews/` (override with `REVIEW_APP_HOME`).

## Develop

```
npm run dev:server   # API + MCP on :4477
npm run dev:ui       # Vite on :5173 (proxies /api and /mcp)
npm test
npm run seed         # submit a demo review of this repo
```
