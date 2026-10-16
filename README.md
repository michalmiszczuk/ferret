# review-app

A local triage desk for AI code reviews. Claude Code sends findings in, you triage them (🔴 → 🟢, code with inline comments), and Claude fixes the ones you pick.

## Install (once)

```
npm install
npm run build
npm link            # puts `review-app` on your PATH
review-app setup    # installs /ai-review + /apply-review skills, registers the MCP server
```

## Use

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
