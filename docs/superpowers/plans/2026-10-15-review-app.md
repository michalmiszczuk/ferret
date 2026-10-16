# review-app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web app plus MCP server where Claude Code submits structured review findings. The user triages them (sorted 🔴→🟢, code shown with inline comments) and sends fix decisions back to Claude in VS Code.

**Architecture:** One Node/TypeScript process on `127.0.0.1:4477` serves three things: an MCP endpoint (`/mcp`, stateless Streamable HTTP) for Claude, a REST + SSE API (`/api`) for the UI, and the built React UI (`/`). Reviews are stored as JSON files in `~/.review-app/reviews/`. Two Claude Code skills (`/ai-review`, `/apply-review`) drive the loop.

**Tech Stack:** Node ≥ 20, TypeScript (strict, ESM), Express 4, `@modelcontextprotocol/sdk` 1.x, Zod 3, React 18 + Vite 5, Shiki 1 (syntax tokens), react-markdown 9, Vitest 2 + Testing Library, tsup (CLI bundle).

**Spec:** `docs/superpowers/specs/2026-10-15-review-app-design.md`

## Global Constraints

- Node `>=20`. ESM only (`"type": "module"`). TypeScript `strict: true`.
- The server binds to `127.0.0.1` only. The default port is `4477`.
- Store directory: `~/.review-app/reviews/`, overridable with env `REVIEW_APP_HOME` (the store dir is then `$REVIEW_APP_HOME/reviews`). **Never write inside the user's repos.**
- Severity values are exactly `critical | high | medium | low`. Colors: critical `#f85149`, high `#f0883e`, medium `#d29922`, low `#3fb950`.
- Status values are exactly `open | fix_requested | fixing | fixed | skipped | dismissed`.
- The UI is dark theme only.
- Skill names are `ai-review` and `apply-review` (not `review`, which clashes with Claude Code's built-in).
- Requests with a `Host` header other than `127.0.0.1:<port>` / `localhost:<port>` get 403.
- **Commits:** the user commits by hand. At each "Commit checkpoint", stop and tell the user which files are ready plus a one-line message. Never run `git commit` yourself.

## Review Focus

1. **Non-ASCII and spaces in paths.** The user's home is `C:\Users\MichałMiszczuk`. File reads and `vscode://` links must work with `ł`, spaces and `#`. Pinned by tests in Task 1 (`vscodeUrl`) and Task 4 (`resolveInRepo` in a `ł` directory).
2. **Claude sends Windows-style or absolute file paths** (`src\a.ts`, `C:\…\repo\src\a.ts`). These must be normalized to repo-relative forward-slash paths, and paths outside the repo must be rejected with a clear error. Pinned in Task 1 (`normalizeFindingPath`) and Task 3 (store rejects).
3. **Code edited after the review / CRLF files.** The comment must stay on the right lines (re-anchor) or say it lost them. A CRLF file with an LF snippet must still match. Pinned in Task 4 (`reanchor`) and Task 6 (pending actions re-anchored).
4. **`/apply-review` run twice.** The second `get_pending_actions` must return nothing, so Claude doesn't apply fixes twice. Pinned in Task 3 and Task 6.
5. **Any website open in the browser can reach `127.0.0.1:4477` (DNS rebinding).** A foreign `Host` must get 403. Pinned in Task 5.

---

## File Structure

```
review-app/
  package.json  tsconfig.json  vite.config.ts  vitest.config.ts  tsup.config.ts  .gitignore  README.md
  src/
    shared/
      schema.ts        # Zod schemas + types: Review, Finding, SubmitReviewInput, FindingPatch
      paths.ts         # normalizeFindingPath, vscodeUrl, repoName (pure, browser-safe)
      findings.ts      # sort/filter/listView/navOrder/countBySeverity/toSummary + labels
      api-types.ts     # ReviewSummary, FileResponse, Anchor, StoreEvent (types only)
    server/
      store.ts         # ReviewStore: load/save JSON, create/update/takePending, emits "change"
      files.ts         # resolveInRepo, readRepoFile, changedLines, reanchor, anchorFinding
      api.ts           # REST + SSE router
      mcp.ts           # MCP tools + /mcp mount
      index.ts         # createApp, startServer, hostGuard
    cli/
      index.ts         # `review-app start|setup`
      setup.ts         # findPackageDir, installSkills, registerMcp
    ui/
      index.html  main.tsx  App.tsx  api.ts  highlight.ts  styles.css
      components/ Header.tsx  FindingsList.tsx  CommentCard.tsx  CodeView.tsx
  skills/
    ai-review/SKILL.md
    apply-review/SKILL.md
  scripts/seed.ts      # manual demo: submits a review of this repo over MCP
  tests/ ...           # mirrors src
```

---

### Task 1: Project scaffold, shared schema and path helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/shared/schema.ts`, `src/shared/paths.ts`
- Test: `tests/shared/schema.test.ts`, `tests/shared/paths.test.ts`

**Interfaces:**
- Produces:
  - `SEVERITIES`, `CATEGORIES`, `STATUSES` (readonly tuples); `Severity`, `Category`, `FindingStatus` types
  - `scopeSchema`, `findingInputSchema`, `submitReviewShape` (Zod raw shape), `submitReviewSchema`, `SubmitReviewInput`
  - `findingSchema`, `Finding`, `reviewSchema`, `Review`, `findingPatchSchema`, `FindingPatch`
  - `toPosix(p: string): string`, `normalizeFindingPath(file: string, repoRoot: string): string` (throws `Error`), `vscodeUrl(repoRoot: string, file: string, line: number): string`, `repoName(repoRoot: string): string`

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "review-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "review-app": "dist/cli.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "dev:server": "tsx watch src/cli/index.ts start",
    "dev:ui": "vite",
    "build": "vite build && tsup",
    "start": "node dist/cli.js start",
    "seed": "tsx scripts/seed.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node", "vite/client"]
  },
  "include": ["src", "tests", "scripts", "vite.config.ts", "vitest.config.ts", "tsup.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 15000,
  },
});
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 2: Install dependencies**

Run:

```
npm install @modelcontextprotocol/sdk@^1 express@^4 zod@^3.25 react@^18 react-dom@^18 react-markdown@^9 shiki@^1
npm install -D typescript@^5 tsx@^4 tsup@^8 vite@^5 @vitejs/plugin-react@^4 vitest@^2 jsdom@^25 @testing-library/react@^16 @testing-library/dom@^10 @testing-library/user-event@^14 @types/node@^22 @types/express@^4 @types/react@^18 @types/react-dom@^18
```

Expected: both finish with no `ERR!` lines.

- [ ] **Step 3: Write the failing tests**

`tests/shared/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findingPatchSchema, submitReviewSchema } from "../../src/shared/schema";

const valid = {
  repoRoot: "C:/repo",
  scope: { kind: "diff", target: "uncommitted" },
  summary: "Looks mostly fine",
  findings: [
    {
      severity: "critical",
      title: "Token never expires",
      body: "Expired sessions are accepted.",
      category: "security",
      file: "src/auth.ts",
      lineStart: 10,
      lineEnd: 12,
      snippet: "return s.user",
    },
  ],
};

describe("submitReviewSchema", () => {
  it("accepts a valid review", () => {
    expect(submitReviewSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a files scope", () => {
    const r = submitReviewSchema.safeParse({ ...valid, scope: { kind: "files", target: ["src/auth/"] } });
    expect(r.success).toBe(true);
  });

  it("rejects lineEnd < lineStart with a message naming lineEnd", () => {
    const bad = { ...valid, findings: [{ ...valid.findings[0], lineStart: 12, lineEnd: 10 }] };
    const r = submitReviewSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("lineEnd");
  });

  it("rejects unknown severity", () => {
    const bad = { ...valid, findings: [{ ...valid.findings[0], severity: "blocker" }] };
    expect(submitReviewSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects line numbers below 1", () => {
    const bad = { ...valid, findings: [{ ...valid.findings[0], lineStart: 0 }] };
    expect(submitReviewSchema.safeParse(bad).success).toBe(false);
  });
});

describe("findingPatchSchema", () => {
  it("allows the user-settable statuses, severity and note", () => {
    expect(findingPatchSchema.safeParse({ status: "fix_requested", myNote: "keep API" }).success).toBe(true);
    expect(findingPatchSchema.safeParse({ status: "dismissed" }).success).toBe(true);
    expect(findingPatchSchema.safeParse({ severity: "low" }).success).toBe(true);
  });

  it("rejects statuses only Claude may set", () => {
    expect(findingPatchSchema.safeParse({ status: "fixed" }).success).toBe(false);
    expect(findingPatchSchema.safeParse({ status: "fixing" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(findingPatchSchema.safeParse({ resolution: "hack" }).success).toBe(false);
  });
});
```

`tests/shared/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeFindingPath, repoName, vscodeUrl } from "../../src/shared/paths";

describe("normalizeFindingPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeFindingPath("src\\auth\\session.ts", "C:\\repo")).toBe("src/auth/session.ts");
  });

  it("strips a leading ./", () => {
    expect(normalizeFindingPath("./src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("makes an absolute Windows path inside the repo relative (case-insensitive drive/dirs)", () => {
    expect(
      normalizeFindingPath("c:\\Users\\MichałMiszczuk\\Code\\app\\src\\a.ts", "C:\\Users\\MichałMiszczuk\\Code\\app"),
    ).toBe("src/a.ts");
  });

  it("makes an absolute POSIX path inside the repo relative", () => {
    expect(normalizeFindingPath("/home/me/app/src/a.ts", "/home/me/app/")).toBe("src/a.ts");
  });

  it("rejects an absolute path outside the repo", () => {
    expect(() => normalizeFindingPath("C:\\other\\a.ts", "C:\\repo")).toThrow(/outside repoRoot/);
  });

  it("rejects a sibling dir sharing a prefix", () => {
    expect(() => normalizeFindingPath("C:/repo-other/a.ts", "C:/repo")).toThrow(/outside repoRoot/);
  });

  it("rejects .. segments", () => {
    expect(() => normalizeFindingPath("src/../../etc/passwd", "/repo")).toThrow(/\.\./);
  });
});

describe("vscodeUrl", () => {
  it("encodes non-ASCII, spaces and # in Windows paths", () => {
    expect(vscodeUrl("C:\\Users\\MichałMiszczuk\\My Code", "src/a#b.ts", 42)).toBe(
      "vscode://file/C:/Users/Micha%C5%82Miszczuk/My%20Code/src/a%23b.ts:42",
    );
  });

  it("handles POSIX roots", () => {
    expect(vscodeUrl("/home/me/app/", "src/a.ts", 3)).toBe("vscode://file/home/me/app/src/a.ts:3");
  });
});

describe("repoName", () => {
  it("returns the last path segment", () => {
    expect(repoName("C:\\Users\\me\\Code\\review-app\\")).toBe("review-app");
    expect(repoName("/home/me/app")).toBe("app");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/shared`
Expected: FAIL. Cannot find modules `../../src/shared/schema` and `../../src/shared/paths`.

- [ ] **Step 5: Implement `src/shared/schema.ts`**

```ts
import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export const CATEGORIES = ["bug", "security", "performance", "maintainability", "style", "other"] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof categorySchema>;

export const STATUSES = ["open", "fix_requested", "fixing", "fixed", "skipped", "dismissed"] as const;
export const statusSchema = z.enum(STATUSES);
export type FindingStatus = z.infer<typeof statusSchema>;

export const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("diff"), target: z.literal("uncommitted") }),
  z.object({ kind: z.literal("files"), target: z.array(z.string().min(1)).min(1) }),
]);
export type Scope = z.infer<typeof scopeSchema>;

export const findingInputSchema = z
  .object({
    severity: severitySchema.describe("critical | high | medium | low — see the severity rules in the ai-review skill"),
    title: z.string().min(1).max(200).describe("One line, shown in the findings list"),
    body: z.string().min(1).describe("Markdown: what is wrong, why it matters, a concrete failure scenario"),
    suggestion: z.string().optional().describe("Proposed fix, prose or code"),
    category: categorySchema,
    file: z.string().min(1).describe("Repo-relative path with forward slashes"),
    lineStart: z.number().int().min(1).describe("1-based, inclusive"),
    lineEnd: z.number().int().min(1).describe("1-based, inclusive, >= lineStart"),
    snippet: z.string().min(1).describe("Exact code of lines lineStart..lineEnd, copied from the file"),
  })
  .refine((f) => f.lineEnd >= f.lineStart, { message: "lineEnd must be >= lineStart", path: ["lineEnd"] });
export type FindingInput = z.infer<typeof findingInputSchema>;

export const submitReviewShape = {
  repoRoot: z.string().min(1).describe("Absolute path of the repository root"),
  scope: scopeSchema,
  summary: z.string().min(1).describe("Short overall verdict"),
  findings: z.array(findingInputSchema),
};
export const submitReviewSchema = z.object(submitReviewShape);
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

export const findingSchema = z.object({
  id: z.string(),
  severity: severitySchema,
  originalSeverity: severitySchema,
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(),
  category: categorySchema,
  file: z.string(),
  lineStart: z.number().int(),
  lineEnd: z.number().int(),
  snippet: z.string(),
  status: statusSchema,
  myNote: z.string().optional(),
  resolution: z.string().optional(),
  updatedAt: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  repoRoot: z.string(),
  scope: scopeSchema,
  summary: z.string(),
  agent: z.literal("claude"),
  findings: z.array(findingSchema),
});
export type Review = z.infer<typeof reviewSchema>;

/** What the UI may change on a finding. Claude-only statuses (fixing/fixed/skipped) are excluded. */
export const findingPatchSchema = z
  .object({
    status: z.enum(["open", "fix_requested", "dismissed"]).optional(),
    severity: severitySchema.optional(),
    myNote: z.string().max(2000).optional(),
  })
  .strict();
export type FindingPatch = z.infer<typeof findingPatchSchema>;
```

- [ ] **Step 6: Implement `src/shared/paths.ts`**

```ts
// Pure string helpers; no node imports so the UI can use them too.

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

const WIN_ABS = /^[a-zA-Z]:\//;

function trimTrailingSlashes(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Turns whatever path Claude sent into a repo-relative, forward-slash path. Throws if it escapes the repo. */
export function normalizeFindingPath(file: string, repoRoot: string): string {
  let f = toPosix(file.trim());
  if (WIN_ABS.test(f) || f.startsWith("/")) {
    const root = trimTrailingSlashes(toPosix(repoRoot));
    const caseInsensitive = WIN_ABS.test(root);
    const fCmp = caseInsensitive ? f.toLowerCase() : f;
    const rootCmp = caseInsensitive ? root.toLowerCase() : root;
    if (!fCmp.startsWith(rootCmp + "/")) {
      throw new Error(`file "${file}" is outside repoRoot "${repoRoot}"`);
    }
    f = f.slice(root.length + 1);
  }
  f = f.replace(/^(\.\/)+/, "");
  if (f.split("/").includes("..")) {
    throw new Error(`file "${file}" must not contain ".." segments`);
  }
  return f;
}

export function vscodeUrl(repoRoot: string, file: string, line: number): string {
  const abs = `${trimTrailingSlashes(toPosix(repoRoot))}/${file}`;
  const withLeadingSlash = abs.startsWith("/") ? abs : `/${abs}`;
  const encoded = encodeURI(withLeadingSlash).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return `vscode://file${encoded}:${line}`;
}

export function repoName(repoRoot: string): string {
  return trimTrailingSlashes(toPosix(repoRoot)).split("/").pop() ?? repoRoot;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/shared`
Expected: PASS, all tests green.

- [ ] **Step 8: Commit checkpoint**

Tell the user these files are ready: `package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/shared tests/shared`. Suggested message: `Scaffold project and shared schema`

---

### Task 2: Findings list logic and test helpers

**Files:**
- Create: `src/shared/api-types.ts`, `src/shared/findings.ts`, `tests/helpers.ts`
- Test: `tests/shared/findings.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Review`, `Severity`, `FindingStatus`, `Scope`, `SEVERITIES`, `SubmitReviewInput` (Task 1); `repoName` (Task 1)
- Produces:
  - `api-types.ts`: `StoreEvent = { type: "review-created" | "review-updated"; reviewId: string }`, `Anchor = { lineStart: number; lineEnd: number; anchor: "exact" | "moved" | "lost" }`, `FileResponse`, `ReviewSummary`
  - `findings.ts`: `SEVERITY_RANK`, `SEVERITY_LABEL`, `SEVERITY_ICON`, `isDone(f)`, `sortFindings(fs)`, `StatusFilter`, `Filters`, `filterFindings(fs, filters)`, `listView(fs, filters) → { active, done }`, `navOrder(fs, filters, doneOpen) → Finding[]`, `countBySeverity(fs) → Record<Severity, number>`, `scopeLabel(scope)`, `toSummary(review) → ReviewSummary`
  - `tests/helpers.ts`: `makeFinding(overrides?)`, `makeReviewInput(repoRoot, findings?)`, `makeRepo(files) → Promise<string>`, `tmpDir(prefix) → Promise<string>`

- [ ] **Step 1: Create `src/shared/api-types.ts`** (types only, no logic to test)

```ts
import type { Review, Severity } from "./schema";

export type StoreEvent = { type: "review-created" | "review-updated"; reviewId: string };

export type Anchor = { lineStart: number; lineEnd: number; anchor: "exact" | "moved" | "lost" };

export type FileResponse =
  | { exists: false }
  | { exists: true; content: string; changedLines: number[]; anchors: Record<string, Anchor> };

export interface ReviewSummary {
  id: string;
  createdAt: string;
  repoName: string;
  scope: Review["scope"];
  counts: Record<Severity, number>;
  pending: number; // findings with status fix_requested
  total: number;
}
```

- [ ] **Step 2: Create `tests/helpers.ts`**

```ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Finding, SubmitReviewInput } from "../src/shared/schema";

export function makeFinding(o: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    severity: "medium",
    originalSeverity: o.severity ?? "medium",
    title: "Something is off",
    body: "Body text",
    category: "bug",
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 1,
    snippet: "x",
    status: "open",
    updatedAt: "2026-10-15T00:00:00.000Z",
    ...o,
  };
}

export function makeReviewInput(
  repoRoot: string,
  findings: SubmitReviewInput["findings"] = [
    { severity: "low", title: "Nit", body: "Rename", category: "style", file: "src/a.ts", lineStart: 1, lineEnd: 1, snippet: "line1" },
    { severity: "critical", title: "Crash", body: "Null deref", category: "bug", file: "src/a.ts", lineStart: 2, lineEnd: 2, snippet: "const x = 1;" },
  ],
): SubmitReviewInput {
  return { repoRoot, scope: { kind: "diff", target: "uncommitted" }, summary: "Test review", findings };
}

export async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Creates a temp directory with the given files (repo-relative path → content). Returns its absolute path. */
export async function makeRepo(files: Record<string, string>, parent?: string): Promise<string> {
  const dir = parent ? parent : await tmpDir("review-app-repo-");
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}
```

- [ ] **Step 3: Write the failing test** `tests/shared/findings.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  countBySeverity, filterFindings, listView, navOrder, scopeLabel, sortFindings, toSummary, type Filters,
} from "../../src/shared/findings";
import { SEVERITIES } from "../../src/shared/schema";
import { makeFinding } from "../helpers";

const all: Filters = { severities: [...SEVERITIES], status: "all" };

describe("sortFindings", () => {
  it("orders by severity, then file, then line, without mutating input", () => {
    const input = [
      makeFinding({ id: "a", severity: "low", file: "a.ts", lineStart: 1 }),
      makeFinding({ id: "b", severity: "critical", file: "z.ts", lineStart: 9 }),
      makeFinding({ id: "c", severity: "critical", file: "b.ts", lineStart: 5 }),
      makeFinding({ id: "d", severity: "critical", file: "b.ts", lineStart: 2 }),
      makeFinding({ id: "e", severity: "high", file: "a.ts", lineStart: 1 }),
    ];
    expect(sortFindings(input).map((f) => f.id)).toEqual(["d", "c", "b", "e", "a"]);
    expect(input[0].id).toBe("a");
  });
});

describe("filterFindings", () => {
  const fs = [
    makeFinding({ id: "open", severity: "high", status: "open" }),
    makeFinding({ id: "req", severity: "low", status: "fix_requested" }),
    makeFinding({ id: "fixing", severity: "high", status: "fixing" }),
    makeFinding({ id: "fixed", severity: "high", status: "fixed" }),
    makeFinding({ id: "dis", severity: "medium", status: "dismissed" }),
    makeFinding({ id: "skip", severity: "medium", status: "skipped" }),
  ];

  it("open = not done (open, fix_requested, fixing)", () => {
    expect(filterFindings(fs, { ...all, status: "open" }).map((f) => f.id)).toEqual(["open", "req", "fixing"]);
  });

  it("done = fixed, dismissed, skipped", () => {
    expect(filterFindings(fs, { ...all, status: "done" }).map((f) => f.id)).toEqual(["fixed", "dis", "skip"]);
  });

  it("filters by severity", () => {
    expect(filterFindings(fs, { severities: ["low"], status: "all" }).map((f) => f.id)).toEqual(["req"]);
  });
});

describe("listView / navOrder", () => {
  const fs = [
    makeFinding({ id: "low", severity: "low" }),
    makeFinding({ id: "crit", severity: "critical" }),
    makeFinding({ id: "done", severity: "critical", status: "fixed" }),
  ];

  it("splits active and done, each sorted", () => {
    const v = listView(fs, all);
    expect(v.active.map((f) => f.id)).toEqual(["crit", "low"]);
    expect(v.done.map((f) => f.id)).toEqual(["done"]);
  });

  it("navOrder skips collapsed done group", () => {
    expect(navOrder(fs, all, false).map((f) => f.id)).toEqual(["crit", "low"]);
    expect(navOrder(fs, all, true).map((f) => f.id)).toEqual(["crit", "low", "done"]);
  });

  it("navOrder includes done when the status filter is done, even if collapsed", () => {
    expect(navOrder(fs, { ...all, status: "done" }, false).map((f) => f.id)).toEqual(["done"]);
  });
});

describe("countBySeverity / scopeLabel / toSummary", () => {
  it("counts every severity, including zeros", () => {
    expect(countBySeverity([makeFinding({ severity: "high" }), makeFinding({ severity: "high" })])).toEqual({
      critical: 0, high: 2, medium: 0, low: 0,
    });
  });

  it("labels scopes", () => {
    expect(scopeLabel({ kind: "diff", target: "uncommitted" })).toBe("uncommitted changes");
    expect(scopeLabel({ kind: "files", target: ["src/a.ts", "lib/"] })).toBe("src/a.ts, lib/");
  });

  it("summarizes a review", () => {
    const s = toSummary({
      id: "r_1", createdAt: "2026-10-15T10:00:00.000Z", repoRoot: "C:\\code\\my-repo",
      scope: { kind: "diff", target: "uncommitted" }, summary: "x", agent: "claude",
      findings: [makeFinding({ severity: "critical", status: "fix_requested" }), makeFinding({ severity: "low" })],
    });
    expect(s).toEqual({
      id: "r_1", createdAt: "2026-10-15T10:00:00.000Z", repoName: "my-repo",
      scope: { kind: "diff", target: "uncommitted" },
      counts: { critical: 1, high: 0, medium: 0, low: 1 }, pending: 1, total: 2,
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/shared/findings.test.ts`
Expected: FAIL. Cannot find module `../../src/shared/findings`.

- [ ] **Step 5: Implement `src/shared/findings.ts`**

```ts
import type { ReviewSummary } from "./api-types";
import { repoName } from "./paths";
import type { Finding, FindingStatus, Review, Scope, Severity } from "./schema";

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const SEVERITY_ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };

const DONE: ReadonlySet<FindingStatus> = new Set(["fixed", "skipped", "dismissed"]);

export function isDone(f: Finding): boolean {
  return DONE.has(f.status);
}

export function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.lineStart - b.lineStart,
  );
}

export type StatusFilter = "all" | "open" | "done";
export interface Filters {
  severities: Severity[];
  status: StatusFilter;
}

export function filterFindings(fs: Finding[], filters: Filters): Finding[] {
  return fs.filter(
    (f) =>
      filters.severities.includes(f.severity) &&
      (filters.status === "all" || (filters.status === "done") === isDone(f)),
  );
}

export function listView(fs: Finding[], filters: Filters): { active: Finding[]; done: Finding[] } {
  const sorted = sortFindings(filterFindings(fs, filters));
  return { active: sorted.filter((f) => !isDone(f)), done: sorted.filter(isDone) };
}

/** The order j/k keyboard navigation walks: what is visible in the list, top to bottom. */
export function navOrder(fs: Finding[], filters: Filters, doneOpen: boolean): Finding[] {
  const { active, done } = listView(fs, filters);
  return [...active, ...(doneOpen || filters.status === "done" ? done : [])];
}

export function countBySeverity(fs: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of fs) counts[f.severity]++;
  return counts;
}

export function scopeLabel(scope: Scope): string {
  return scope.kind === "diff" ? "uncommitted changes" : scope.target.join(", ");
}

export function toSummary(r: Review): ReviewSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    repoName: repoName(r.repoRoot),
    scope: r.scope,
    counts: countBySeverity(r.findings),
    pending: r.findings.filter((f) => f.status === "fix_requested").length,
    total: r.findings.length,
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/shared`
Expected: PASS.

- [ ] **Step 7: Commit checkpoint**

Files: `src/shared/api-types.ts src/shared/findings.ts tests/helpers.ts tests/shared/findings.test.ts`. Suggested message: `Add findings list logic`

---

### Task 3: Review store

**Files:**
- Create: `src/server/store.ts`
- Test: `tests/server/store.test.ts`

**Interfaces:**
- Consumes: `Review`, `Finding`, `SubmitReviewInput`, `reviewSchema` (Task 1); `normalizeFindingPath` (Task 1); `sortFindings` (Task 2); `StoreEvent` (Task 2)
- Produces: `class ReviewStore extends EventEmitter` with
  - `constructor(dir: string, log?: (msg: string) => void)`
  - `load(): Promise<void>`
  - `list(): Review[]` (newest first), `get(id: string): Review | undefined`, `latest(): Review | undefined`
  - `create(input: SubmitReviewInput): Promise<Review>`, which throws `Error` on a bad path
  - `updateFinding(reviewId: string, findingId: string, patch: FindingUpdate): Promise<Finding>`, where `FindingUpdate = Partial<Pick<Finding, "status" | "severity" | "myNote" | "resolution">>`. Throws `NotFoundError`.
  - `takePending(reviewId?: string): Promise<{ review: Review; findings: Finding[] }>`. Throws `NotFoundError`.
  - `countFixing(reviewId: string): number`
  - emits `"change"` with a `StoreEvent`
  - `class NotFoundError extends Error`

- [ ] **Step 1: Write the failing test** `tests/server/store.test.ts`

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreEvent } from "../../src/shared/api-types";
import { NotFoundError, ReviewStore } from "../../src/server/store";
import { makeReviewInput, tmpDir } from "../helpers";

async function newStore() {
  const dir = await tmpDir("review-app-store-");
  const store = new ReviewStore(dir, () => {});
  await store.load();
  return { dir, store };
}

afterEach(() => vi.useRealTimers());

describe("ReviewStore.create", () => {
  it("assigns ids, defaults, normalizes paths and persists to disk", async () => {
    const { dir, store } = await newStore();
    const input = makeReviewInput("C:\\repo");
    input.findings[0].file = "src\\a.ts";
    const review = await store.create(input);

    expect(review.id).toMatch(/^r_[0-9a-f]{6}$/);
    expect(review.agent).toBe("claude");
    expect(review.findings.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(review.findings[0]).toMatchObject({ file: "src/a.ts", status: "open", originalSeverity: "low" });

    const reloaded = new ReviewStore(dir, () => {});
    await reloaded.load();
    expect(reloaded.get(review.id)).toEqual(review);
  });

  it("emits review-created", async () => {
    const { store } = await newStore();
    const events: StoreEvent[] = [];
    store.on("change", (e: StoreEvent) => events.push(e));
    const review = await store.create(makeReviewInput("/repo"));
    expect(events).toEqual([{ type: "review-created", reviewId: review.id }]);
  });

  it("rejects a finding outside the repo and stores nothing", async () => {
    const { dir, store } = await newStore();
    const input = makeReviewInput("C:\\repo");
    input.findings[0].file = "C:\\elsewhere\\x.ts";
    await expect(store.create(input)).rejects.toThrow(/outside repoRoot/);
    expect(store.list()).toEqual([]);
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".json"))).toEqual([]);
  });
});

describe("ReviewStore.list / latest", () => {
  it("returns newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store } = await newStore();
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    const older = await store.create(makeReviewInput("/repo"));
    vi.setSystemTime(new Date("2026-10-15T11:00:00Z"));
    const newer = await store.create(makeReviewInput("/repo"));
    expect(store.list().map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(store.latest()?.id).toBe(newer.id);
  });
});

describe("ReviewStore.updateFinding", () => {
  it("patches, persists and emits review-updated", async () => {
    const { dir, store } = await newStore();
    const review = await store.create(makeReviewInput("/repo"));
    const events: StoreEvent[] = [];
    store.on("change", (e: StoreEvent) => events.push(e));

    const f = await store.updateFinding(review.id, "f2", { status: "fix_requested", myNote: "keep API" });
    expect(f).toMatchObject({ status: "fix_requested", myNote: "keep API" });
    expect(events).toEqual([{ type: "review-updated", reviewId: review.id }]);

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, `${review.id}.json`), "utf8"));
    expect(onDisk.findings[1].status).toBe("fix_requested");
  });

  it("throws NotFoundError for unknown review or finding", async () => {
    const { store } = await newStore();
    const review = await store.create(makeReviewInput("/repo"));
    await expect(store.updateFinding("r_nope", "f1", {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.updateFinding(review.id, "f9", {})).rejects.toThrow("Finding f9 not found");
  });
});

describe("ReviewStore.takePending", () => {
  it("moves fix_requested to fixing, sorted by severity; a second call returns nothing", async () => {
    const { store } = await newStore();
    const review = await store.create(makeReviewInput("/repo"));
    await store.updateFinding(review.id, "f1", { status: "fix_requested" }); // low
    await store.updateFinding(review.id, "f2", { status: "fix_requested" }); // critical

    const first = await store.takePending(review.id);
    expect(first.findings.map((f) => f.id)).toEqual(["f2", "f1"]);
    expect(store.get(review.id)!.findings.every((f) => f.status === "fixing")).toBe(true);
    expect(store.countFixing(review.id)).toBe(2);

    const second = await store.takePending(review.id);
    expect(second.findings).toEqual([]);
  });

  it("uses the latest review when no id is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store } = await newStore();
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    await store.create(makeReviewInput("/repo"));
    vi.setSystemTime(new Date("2026-10-15T11:00:00Z"));
    const newer = await store.create(makeReviewInput("/repo"));
    expect((await store.takePending()).review.id).toBe(newer.id);
  });

  it("explains when there are no reviews", async () => {
    const { store } = await newStore();
    await expect(store.takePending()).rejects.toThrow(/No reviews yet/);
  });
});

describe("ReviewStore.load", () => {
  it("skips corrupt files and logs a warning", async () => {
    const dir = await tmpDir("review-app-store-");
    await fs.writeFile(path.join(dir, "r_bad000.json"), "{ not json");
    const logs: string[] = [];
    const store = new ReviewStore(dir, (m) => logs.push(m));
    await store.load();
    expect(store.list()).toEqual([]);
    expect(logs.join("\n")).toContain("r_bad000.json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/store.test.ts`
Expected: FAIL. Cannot find module `../../src/server/store`.

- [ ] **Step 3: Implement `src/server/store.ts`**

```ts
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { StoreEvent } from "../shared/api-types";
import { sortFindings } from "../shared/findings";
import { normalizeFindingPath } from "../shared/paths";
import { reviewSchema, type Finding, type Review, type SubmitReviewInput } from "../shared/schema";

export class NotFoundError extends Error {}

export type FindingUpdate = Partial<Pick<Finding, "status" | "severity" | "myNote" | "resolution">>;

function newReviewId(): string {
  return `r_${randomBytes(3).toString("hex")}`;
}

export class ReviewStore extends EventEmitter {
  private reviews = new Map<string, Review>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly log: (msg: string) => void = console.warn,
  ) {
    super();
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(this.dir, name);
      try {
        const review = reviewSchema.parse(JSON.parse(await fs.readFile(full, "utf8")));
        this.reviews.set(review.id, review);
      } catch (err) {
        this.log(`review-app: skipping unreadable review file ${full}: ${(err as Error).message}`);
      }
    }
  }

  list(): Review[] {
    return [...this.reviews.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Review | undefined {
    return this.reviews.get(id);
  }

  latest(): Review | undefined {
    return this.list()[0];
  }

  async create(input: SubmitReviewInput): Promise<Review> {
    const now = new Date().toISOString();
    const findings: Finding[] = input.findings.map((f, i) => ({
      ...f,
      file: normalizeFindingPath(f.file, input.repoRoot),
      id: `f${i + 1}`,
      originalSeverity: f.severity,
      status: "open",
      updatedAt: now,
    }));
    let id = newReviewId();
    while (this.reviews.has(id)) id = newReviewId();
    const review: Review = {
      id,
      createdAt: now,
      repoRoot: input.repoRoot,
      scope: input.scope,
      summary: input.summary,
      agent: "claude",
      findings,
    };
    this.reviews.set(review.id, review);
    await this.persist(review);
    this.emitChange({ type: "review-created", reviewId: review.id });
    return review;
  }

  async updateFinding(reviewId: string, findingId: string, patch: FindingUpdate): Promise<Finding> {
    const review = this.requireReview(reviewId);
    const finding = review.findings.find((f) => f.id === findingId);
    if (!finding) throw new NotFoundError(`Finding ${findingId} not found in review ${reviewId}`);
    Object.assign(finding, patch, { updatedAt: new Date().toISOString() });
    await this.persist(review);
    this.emitChange({ type: "review-updated", reviewId });
    return finding;
  }

  async takePending(reviewId?: string): Promise<{ review: Review; findings: Finding[] }> {
    const review = reviewId ? this.requireReview(reviewId) : this.latest();
    if (!review) throw new NotFoundError("No reviews yet. Run /ai-review first.");
    const pending = sortFindings(review.findings.filter((f) => f.status === "fix_requested"));
    if (pending.length > 0) {
      const now = new Date().toISOString();
      for (const f of pending) {
        f.status = "fixing";
        f.updatedAt = now;
      }
      await this.persist(review);
      this.emitChange({ type: "review-updated", reviewId: review.id });
    }
    return { review, findings: pending };
  }

  countFixing(reviewId: string): number {
    return this.requireReview(reviewId).findings.filter((f) => f.status === "fixing").length;
  }

  private requireReview(id: string): Review {
    const review = this.reviews.get(id);
    if (!review) throw new NotFoundError(`Review ${id} not found`);
    return review;
  }

  private emitChange(e: StoreEvent): void {
    this.emit("change", e);
  }

  /** Writes are serialized and atomic (tmp file + rename) so a crash never leaves half a JSON file. */
  private persist(review: Review): Promise<void> {
    const data = JSON.stringify(review, null, 2);
    const file = path.join(this.dir, `${review.id}.json`);
    const write = async () => {
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, data, "utf8");
      await fs.rename(tmp, file);
    };
    const p = this.writeQueue.then(write, write);
    this.writeQueue = p.catch(() => {});
    return p;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

Files: `src/server/store.ts tests/server/store.test.ts`. Suggested message: `Add review store`

---

### Task 4: File access, git diff lines and re-anchoring

**Files:**
- Create: `src/server/files.ts`
- Test: `tests/server/files.test.ts`

**Interfaces:**
- Consumes: `Anchor` (Task 2); `makeRepo`, `tmpDir` (Task 2)
- Produces:
  - `class PathError extends Error`
  - `resolveInRepo(repoRoot: string, rel: string): Promise<{ abs: string; exists: boolean }>`, which throws `PathError`
  - `readRepoFile(repoRoot: string, rel: string): Promise<{ exists: false } | { exists: true; content: string }>`
  - `splitLines(s: string): string[]`
  - `parseDiffNewLines(diff: string): number[]`
  - `changedLines(repoRoot: string, rel: string, totalLines: number): Promise<number[]>`
  - `reanchor(content: string, f: { lineStart: number; lineEnd: number; snippet: string }): Anchor`
  - `anchorFinding(repoRoot: string, f: { file: string; lineStart: number; lineEnd: number; snippet: string }): Promise<Anchor & { exists: boolean }>`

- [ ] **Step 1: Write the failing test** `tests/server/files.test.ts`

```ts
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  anchorFinding, changedLines, parseDiffNewLines, PathError, readRepoFile, reanchor, resolveInRepo,
} from "../../src/server/files";
import { makeRepo, tmpDir } from "../helpers";

describe("resolveInRepo / readRepoFile", () => {
  it("reads a file in a directory with non-ASCII characters and spaces", async () => {
    const parent = await tmpDir("review-app-");
    const repo = await makeRepo({ "src/a.ts": "hello" }, path.join(parent, "Michał repo"));
    expect(await readRepoFile(repo, "src/a.ts")).toEqual({ exists: true, content: "hello" });
  });

  it("reports missing files without throwing", async () => {
    const repo = await makeRepo({});
    expect(await readRepoFile(repo, "nope.ts")).toEqual({ exists: false });
  });

  it("rejects .. and absolute paths", async () => {
    const repo = await makeRepo({ "a.ts": "x" });
    await expect(resolveInRepo(repo, "../secret.txt")).rejects.toBeInstanceOf(PathError);
    await expect(resolveInRepo(repo, path.join(repo, "a.ts"))).rejects.toBeInstanceOf(PathError);
  });

  it("rejects a link that escapes the repo", async () => {
    const outside = await makeRepo({ "secret.txt": "top secret" });
    const repo = await makeRepo({ "a.ts": "x" });
    await fs.symlink(outside, path.join(repo, "out"), "junction");
    await expect(readRepoFile(repo, "out/secret.txt")).rejects.toBeInstanceOf(PathError);
  });

  it("rejects directories", async () => {
    const repo = await makeRepo({ "src/a.ts": "x" });
    await expect(readRepoFile(repo, "src")).rejects.toBeInstanceOf(PathError);
  });
});

describe("parseDiffNewLines", () => {
  it("collects new-side line numbers from hunk headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "@@ -3,0 +4,2 @@",
      "+added",
      "+added",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      "@@ -20,3 +23,0 @@",
    ].join("\n");
    expect(parseDiffNewLines(diff)).toEqual([4, 5, 12]);
  });
});

describe("changedLines", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

  it("returns modified lines vs HEAD, all lines for untracked files, [] outside git", async () => {
    const repo = await makeRepo({ "a.ts": "one\ntwo\nthree\n" });
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    await fs.writeFile(path.join(repo, "a.ts"), "one\nTWO\nthree\nfour\n");
    await fs.writeFile(path.join(repo, "new.ts"), "a\nb\n");

    expect(await changedLines(repo, "a.ts", 5)).toEqual([2, 4]);
    expect(await changedLines(repo, "new.ts", 3)).toEqual([1, 2, 3]);

    const plain = await makeRepo({ "a.ts": "x" });
    expect(await changedLines(plain, "a.ts", 1)).toEqual([]);
  });
});

describe("reanchor", () => {
  const file = ["import x", "", "function a() {", "  return s.user", "}", "", "function b() {", "  return s.user", "}"].join("\n");

  it("exact when the snippet is still at its lines (indentation-insensitive)", () => {
    expect(reanchor(file, { lineStart: 4, lineEnd: 4, snippet: "return s.user" })).toEqual({
      lineStart: 4, lineEnd: 4, anchor: "exact",
    });
  });

  it("moved when lines were inserted above", () => {
    const edited = "// new header\n// another\n" + file;
    expect(reanchor(edited, { lineStart: 3, lineEnd: 4, snippet: "function a() {\n  return s.user" })).toEqual({
      lineStart: 5, lineEnd: 6, anchor: "moved",
    });
  });

  it("picks the match nearest the original line when there are several", () => {
    const edited = "// x\n" + file; // "return s.user" now at 5 and 9
    expect(reanchor(edited, { lineStart: 8, lineEnd: 8, snippet: "return s.user" })).toEqual({
      lineStart: 9, lineEnd: 9, anchor: "moved",
    });
  });

  it("lost when the snippet is gone", () => {
    expect(reanchor(file, { lineStart: 4, lineEnd: 4, snippet: "return s.admin" })).toEqual({
      lineStart: 4, lineEnd: 4, anchor: "lost",
    });
  });

  it("matches a CRLF file against an LF snippet with a trailing newline", () => {
    const crlf = file.replace(/\n/g, "\r\n");
    expect(reanchor(crlf, { lineStart: 3, lineEnd: 4, snippet: "function a() {\n  return s.user\n" })).toEqual({
      lineStart: 3, lineEnd: 4, anchor: "exact",
    });
  });

  it("lost when the original range runs past the end of the file and the snippet is gone", () => {
    expect(reanchor("a\nb", { lineStart: 50, lineEnd: 51, snippet: "zzz" }).anchor).toBe("lost");
  });
});

describe("anchorFinding", () => {
  it("reports missing files as lost + exists:false", async () => {
    const repo = await makeRepo({});
    expect(await anchorFinding(repo, { file: "gone.ts", lineStart: 2, lineEnd: 3, snippet: "x" })).toEqual({
      lineStart: 2, lineEnd: 3, anchor: "lost", exists: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/files.test.ts`
Expected: FAIL. Cannot find module `../../src/server/files`.

- [ ] **Step 3: Implement `src/server/files.ts`**

```ts
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Anchor } from "../shared/api-types";

const execFileP = promisify(execFile);

export class PathError extends Error {}

function ensureInside(root: string, target: string, rel: string): void {
  const r = path.relative(root, target);
  if (r === "" || r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) {
    throw new PathError(`Path is outside the repository: ${rel}`);
  }
}

/** Resolves a repo-relative path, refusing anything (incl. symlinks/junctions) that lands outside repoRoot. */
export async function resolveInRepo(repoRoot: string, rel: string): Promise<{ abs: string; exists: boolean }> {
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new PathError(`Invalid path: ${rel}`);
  }
  const rootReal = await fs.realpath(repoRoot);
  const abs = path.resolve(rootReal, rel);
  ensureInside(rootReal, abs, rel);
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { abs, exists: false };
    throw err;
  }
  ensureInside(rootReal, real, rel);
  return { abs: real, exists: true };
}

export async function readRepoFile(
  repoRoot: string,
  rel: string,
): Promise<{ exists: false } | { exists: true; content: string }> {
  const { abs, exists } = await resolveInRepo(repoRoot, rel);
  if (!exists) return { exists: false };
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new PathError(`Not a file: ${rel}`);
  return { exists: true, content: await fs.readFile(abs, "utf8") };
}

export function splitLines(s: string): string[] {
  return s.split(/\r?\n/);
}

export function parseDiffNewLines(diff: string): number[] {
  const out: number[] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) out.push(start + i);
  }
  return out;
}

/** Lines of `rel` that differ from HEAD. Untracked file → every line. Not a git repo / any git error → []. */
export async function changedLines(repoRoot: string, rel: string, totalLines: number): Promise<number[]> {
  try {
    const { stdout: untracked } = await execFileP(
      "git", ["ls-files", "--others", "--exclude-standard", "--", rel], { cwd: repoRoot },
    );
    if (untracked.trim()) return Array.from({ length: totalLines }, (_, i) => i + 1);
    const { stdout } = await execFileP(
      "git", ["diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD", "--", rel],
      { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 },
    );
    return parseDiffNewLines(stdout);
  } catch {
    return [];
  }
}

/** Finds where a finding's snippet lives in the current file. Comparison ignores leading/trailing whitespace per line. */
export function reanchor(content: string, f: { lineStart: number; lineEnd: number; snippet: string }): Anchor {
  const fileLines = splitLines(content).map((l) => l.trim());
  const snip = splitLines(f.snippet).map((l) => l.trim());
  while (snip.length > 1 && snip[snip.length - 1] === "") snip.pop();
  while (snip.length > 1 && snip[0] === "") snip.shift();
  const n = snip.length;

  const matchesAt = (i: number): boolean => {
    if (i < 0 || i + n > fileLines.length) return false;
    for (let k = 0; k < n; k++) if (fileLines[i + k] !== snip[k]) return false;
    return true;
  };

  const orig = f.lineStart - 1;
  if (matchesAt(orig)) return { lineStart: f.lineStart, lineEnd: f.lineStart + n - 1, anchor: "exact" };

  let best = -1;
  for (let i = 0; i + n <= fileLines.length; i++) {
    if (matchesAt(i) && (best === -1 || Math.abs(i - orig) < Math.abs(best - orig))) best = i;
  }
  if (best === -1) return { lineStart: f.lineStart, lineEnd: f.lineEnd, anchor: "lost" };
  return { lineStart: best + 1, lineEnd: best + n, anchor: "moved" };
}

export async function anchorFinding(
  repoRoot: string,
  f: { file: string; lineStart: number; lineEnd: number; snippet: string },
): Promise<Anchor & { exists: boolean }> {
  const lost = { lineStart: f.lineStart, lineEnd: f.lineEnd, anchor: "lost" as const, exists: false };
  try {
    const file = await readRepoFile(repoRoot, f.file);
    if (!file.exists) return lost;
    return { ...reanchor(file.content, f), exists: true };
  } catch {
    return lost;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/files.test.ts`
Expected: PASS. (The junction test works on Windows without admin rights. On macOS/Linux the `"junction"` type is ignored and a normal symlink is created.)

- [ ] **Step 5: Commit checkpoint**

Files: `src/server/files.ts tests/server/files.test.ts`. Suggested message: `Add safe file reads and re-anchoring`

---

### Task 5: HTTP server, REST API and live events

**Files:**
- Create: `src/server/api.ts`, `src/server/index.ts`
- Modify: `tests/helpers.ts` (append `startTestServer`)
- Test: `tests/server/api.test.ts`

**Interfaces:**
- Consumes: `ReviewStore`, `NotFoundError` (Task 3); `readRepoFile`, `changedLines`, `reanchor`, `splitLines`, `PathError` (Task 4); `toSummary` (Task 2); `findingPatchSchema` (Task 1); `StoreEvent`, `FileResponse` (Task 2)
- Produces:
  - `createApiRouter(store: ReviewStore): express.Router`
  - `hostGuard(getPort: () => number): express.RequestHandler`
  - `createApp(opts: { store: ReviewStore; getPort: () => number; uiDir?: string }): express.Express`. Task 6 adds the MCP mount inside this function.
  - `startServer(opts?: { port?: number; home?: string; uiDir?: string; log?: (m: string) => void }): Promise<RunningServer>` with `RunningServer = { url: string; port: number; store: ReviewStore; close(): Promise<void> }`
  - `defaultHome(): string`
  - REST: `GET /api/reviews` → `ReviewSummary[]` · `GET /api/reviews/:id` → `Review` · `PATCH /api/reviews/:id/findings/:fid` (body `FindingPatch`) → `Finding` · `GET /api/reviews/:id/file?path=` → `FileResponse` · `GET /api/events` → SSE `data: StoreEvent`
  - `tests/helpers.ts`: `startTestServer(): Promise<RunningServer & { home: string }>`

- [ ] **Step 1: Append to `tests/helpers.ts`**

```ts
import { startServer, type RunningServer } from "../src/server/index";

export async function startTestServer(): Promise<RunningServer & { home: string }> {
  const home = await tmpDir("review-app-home-");
  const server = await startServer({ port: 0, home, log: () => {} });
  return { ...server, home };
}
```

(Move the new `import` line to the top of the file with the other imports.)

- [ ] **Step 2: Write the failing test** `tests/server/api.test.ts`

```ts
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../../src/server/index";
import { makeRepo, makeReviewInput, startTestServer } from "../helpers";

let srv: RunningServer & { home: string };
let repo: string;

beforeEach(async () => {
  repo = await makeRepo({ "src/a.ts": "line1\nconst x = 1;\nline3\n" });
  srv = await startTestServer();
});
afterEach(async () => {
  await srv.close();
});

const get = (p: string) => fetch(srv.url + p);
const patch = (p: string, body: unknown) =>
  fetch(srv.url + p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("REST API", () => {
  it("lists review summaries newest first", async () => {
    expect(await (await get("/api/reviews")).json()).toEqual([]);
    const review = await srv.store.create(makeReviewInput(repo));
    const list = await (await get("/api/reviews")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: review.id, total: 2, pending: 0, counts: { critical: 1, low: 1 } });
  });

  it("returns a review or 404", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    expect((await (await get(`/api/reviews/${review.id}`)).json()).id).toBe(review.id);
    expect((await get("/api/reviews/r_nope")).status).toBe(404);
  });

  it("patches user-settable fields and rejects Claude-only statuses", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    const ok = await patch(`/api/reviews/${review.id}/findings/f2`, { status: "fix_requested", myNote: "keep API" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "fix_requested", myNote: "keep API" });

    expect((await patch(`/api/reviews/${review.id}/findings/f2`, { status: "fixed" })).status).toBe(400);
    expect((await patch(`/api/reviews/${review.id}/findings/f9`, { status: "open" })).status).toBe(404);
  });

  it("serves file content with anchors for that file's findings", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    const body = await (await get(`/api/reviews/${review.id}/file?path=src/a.ts`)).json();
    expect(body.exists).toBe(true);
    expect(body.content).toContain("const x = 1;");
    expect(body.changedLines).toEqual([]);
    expect(body.anchors.f2).toEqual({ lineStart: 2, lineEnd: 2, anchor: "exact" });
  });

  it("reports missing files and rejects escaping paths", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    expect(await (await get(`/api/reviews/${review.id}/file?path=gone.ts`)).json()).toEqual({ exists: false });
    expect((await get(`/api/reviews/${review.id}/file?path=../x`)).status).toBe(400);
    expect((await get(`/api/reviews/${review.id}/file`)).status).toBe(400);
  });
});

describe("SSE /api/events", () => {
  it("pushes review-updated when a finding changes", async () => {
    const review = await srv.store.create(makeReviewInput(repo));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(srv.url + "/api/events", { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = dec.decode((await reader.read()).value); // ": connected"

    await srv.store.updateFinding(review.id, "f1", { status: "dismissed" });
    while (!buf.includes("review-updated")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    clearTimeout(timer);
    ac.abort();
    expect(buf).toContain(`"reviewId":"${review.id}"`);
  });
});

describe("host guard", () => {
  it("rejects requests whose Host header is not localhost", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: srv.port, path: "/api/reviews", headers: { Host: `evil.example:${srv.port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("accepts localhost:<port>", async () => {
    const res = await fetch(`http://localhost:${srv.port}/api/reviews`).catch(() => null);
    // On some machines "localhost" resolves to ::1 only, where nothing listens. That is fine; we only assert no 403.
    if (res) expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/server/api.test.ts`
Expected: FAIL. Cannot find module `../src/server/index`.

- [ ] **Step 4: Implement `src/server/api.ts`**

```ts
import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { FileResponse, StoreEvent } from "../shared/api-types";
import { toSummary } from "../shared/findings";
import { findingPatchSchema } from "../shared/schema";
import { changedLines, PathError, readRepoFile, reanchor, splitLines } from "./files";
import { NotFoundError, type ReviewStore } from "./store";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function createApiRouter(store: ReviewStore): Router {
  const r = Router();
  r.use(express.json({ limit: "1mb" }));

  r.get("/reviews", (_req, res) => {
    res.json(store.list().map(toSummary));
  });

  r.get("/reviews/:id", (req, res) => {
    const review = store.get(req.params.id);
    if (!review) return void res.status(404).json({ error: "Review not found" });
    res.json(review);
  });

  r.patch(
    "/reviews/:id/findings/:fid",
    wrap(async (req, res) => {
      const parsed = findingPatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      try {
        res.json(await store.updateFinding(req.params.id, req.params.fid, parsed.data));
      } catch (err) {
        if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.get(
    "/reviews/:id/file",
    wrap(async (req, res) => {
      const review = store.get(req.params.id);
      if (!review) return res.status(404).json({ error: "Review not found" });
      const rel = typeof req.query.path === "string" ? req.query.path : "";
      if (!rel) return res.status(400).json({ error: "Missing ?path=" });
      try {
        const file = await readRepoFile(review.repoRoot, rel);
        if (!file.exists) return res.json({ exists: false } satisfies FileResponse);
        const anchors = Object.fromEntries(
          review.findings.filter((f) => f.file === rel).map((f) => [f.id, reanchor(file.content, f)]),
        );
        const body: FileResponse = {
          exists: true,
          content: file.content,
          changedLines: await changedLines(review.repoRoot, rel, splitLines(file.content).length),
          anchors,
        };
        res.json(body);
      } catch (err) {
        if (err instanceof PathError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const onChange = (e: StoreEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    store.on("change", onChange);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      store.off("change", onChange);
    });
  });

  return r;
}
```

- [ ] **Step 5: Implement `src/server/index.ts`**

```ts
import express, { type RequestHandler } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApiRouter } from "./api";
import { ReviewStore } from "./store";

export const HOST = "127.0.0.1";

export function defaultHome(): string {
  return process.env.REVIEW_APP_HOME ?? path.join(os.homedir(), ".review-app");
}

/** Blocks DNS-rebinding: only requests addressed to localhost on our port get through. */
export function hostGuard(getPort: () => number): RequestHandler {
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    const port = getPort();
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return next();
    res.status(403).send("Forbidden host");
  };
}

export function createApp(opts: { store: ReviewStore; getPort: () => number; uiDir?: string }): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(hostGuard(opts.getPort));
  app.use("/api", createApiRouter(opts.store));
  if (opts.uiDir) {
    const uiDir = opts.uiDir;
    app.use(express.static(uiDir));
    app.get("*", (_req, res) => res.sendFile(path.join(uiDir, "index.html")));
  }
  app.use(((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }) as express.ErrorRequestHandler);
  return app;
}

export interface RunningServer {
  url: string;
  port: number;
  store: ReviewStore;
  close(): Promise<void>;
}

export async function startServer(
  opts: { port?: number; home?: string; uiDir?: string; log?: (m: string) => void } = {},
): Promise<RunningServer> {
  const store = new ReviewStore(path.join(opts.home ?? defaultHome(), "reviews"), opts.log);
  await store.load();
  let port = opts.port ?? 4477;
  const app = createApp({ store, getPort: () => port, uiDir: opts.uiDir });
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, HOST, () => resolve(s));
    s.on("error", reject);
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${HOST}:${port}`,
    port,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/server`
Expected: PASS (store, files and api suites).

- [ ] **Step 7: Commit checkpoint**

Files: `src/server/api.ts src/server/index.ts tests/helpers.ts tests/server/api.test.ts`. Suggested message: `Add HTTP server and REST API`

---

### Task 6: MCP tools

**Files:**
- Create: `src/server/mcp.ts`
- Modify: `src/server/index.ts` (mount MCP in `createApp`)
- Test: `tests/server/mcp.test.ts`

**Interfaces:**
- Consumes: `ReviewStore` (Task 3), `anchorFinding` (Task 4), `countBySeverity` (Task 2), `submitReviewShape` (Task 1), `createApp` (Task 5)
- Produces:
  - `buildMcpServer(store: ReviewStore, getBaseUrl: () => string): McpServer`
  - `mountMcp(app: express.Express, store: ReviewStore, getBaseUrl: () => string): void` (POST `/mcp`, 405 for GET/DELETE)
  - MCP tools `submit_review`, `get_pending_actions`, `mark_done`, as specified in spec §4. Every tool returns a single text content item containing JSON. Errors return `isError: true`.

- [ ] **Step 1: Write the failing test** `tests/server/mcp.test.ts`

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../../src/server/index";
import { makeRepo, makeReviewInput, startTestServer } from "../helpers";

let srv: RunningServer & { home: string };
let client: Client;
let repo: string;

beforeEach(async () => {
  repo = await makeRepo({ "src/a.ts": "line1\nconst x = 1;\nline3\n" });
  srv = await startTestServer();
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
});
afterEach(async () => {
  await client.close();
  await srv.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = (r: any) => JSON.parse(r.content[0].text);
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

/** The SDK may surface validation failures as a thrown error or as an isError result; accept both. */
async function errorText(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const r = await call(name, args);
    expect(r.isError).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (r as any).content[0].text as string;
  } catch (err) {
    return (err as Error).message;
  }
}

const markFix = (reviewId: string, fid: string, myNote?: string) =>
  fetch(`${srv.url}/api/reviews/${reviewId}/findings/${fid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "fix_requested", ...(myNote ? { myNote } : {}) }),
  });

describe("MCP tools", () => {
  it("lists the three tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_pending_actions", "mark_done", "submit_review"]);
  });

  it("submit_review stores the review and returns id, url and counts", async () => {
    const out = data(await call("submit_review", makeReviewInput(repo)));
    expect(out.reviewId).toMatch(/^r_/);
    expect(out.url).toBe(`${srv.url}/r/${out.reviewId}`);
    expect(out.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 1 });
    expect(srv.store.get(out.reviewId)).toBeDefined();
  });

  it("submit_review rejects invalid findings with a useful message", async () => {
    const input = makeReviewInput(repo);
    input.findings[0].lineEnd = 0;
    expect(await errorText("submit_review", input)).toMatch(/lineEnd/);
  });

  it("submit_review rejects files outside the repo", async () => {
    const input = makeReviewInput(repo);
    input.findings[0].file = "C:\\totally\\elsewhere.ts";
    expect(await errorText("submit_review", input)).toMatch(/outside repoRoot/);
  });

  it("full loop: pending (with note, re-anchored) → fixing → mark_done → fixed; second pull is empty", async () => {
    const { reviewId } = data(await call("submit_review", makeReviewInput(repo)));
    await markFix(reviewId, "f2", "keep the API");
    // Code changed after the review: two lines inserted on top.
    await fs.writeFile(path.join(repo, "src/a.ts"), "// a\n// b\nline1\nconst x = 1;\nline3\n");

    const pending = data(await call("get_pending_actions", { reviewId }));
    expect(pending.repoRoot).toBe(repo);
    expect(pending.actions).toHaveLength(1);
    expect(pending.actions[0]).toMatchObject({
      findingId: "f2", myNote: "keep the API", file: "src/a.ts", lineStart: 4, lineEnd: 4, anchor: "moved",
    });
    expect(srv.store.get(reviewId)!.findings[1].status).toBe("fixing");

    const again = data(await call("get_pending_actions", { reviewId }));
    expect(again.actions).toEqual([]);
    expect(again.message).toMatch(/Nothing pending/);

    const done = data(await call("mark_done", { reviewId, findingId: "f2", outcome: "fixed", note: "Added null check" }));
    expect(done).toEqual({ ok: true, remaining: 0 });
    expect(srv.store.get(reviewId)!.findings[1]).toMatchObject({ status: "fixed", resolution: "Added null check" });
  });

  it("get_pending_actions without id uses the latest review", async () => {
    const { reviewId } = data(await call("submit_review", makeReviewInput(repo)));
    await markFix(reviewId, "f1");
    const pending = data(await call("get_pending_actions", {}));
    expect(pending.reviewId).toBe(reviewId);
    expect(pending.actions.map((a: { findingId: string }) => a.findingId)).toEqual(["f1"]);
  });

  it("errors clearly when there are no reviews or ids are wrong", async () => {
    expect(await errorText("get_pending_actions", {})).toMatch(/No reviews yet/);
    expect(await errorText("mark_done", { reviewId: "r_x", findingId: "f1", outcome: "fixed", note: "n" })).toMatch(/not found/);
  });

  it("GET /mcp is 405", async () => {
    expect((await fetch(`${srv.url}/mcp`)).status).toBe(405);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/mcp.test.ts`
Expected: FAIL. `client.connect` fails because POST `/mcp` returns 404.

- [ ] **Step 3: Implement `src/server/mcp.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { countBySeverity } from "../shared/findings";
import { submitReviewShape } from "../shared/schema";
import { anchorFinding } from "./files";
import type { ReviewStore } from "./store";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
  isError: true,
});

export function buildMcpServer(store: ReviewStore, getBaseUrl: () => string): McpServer {
  const server = new McpServer({ name: "review-app", version: "0.1.0" });

  server.registerTool(
    "submit_review",
    {
      title: "Submit code review",
      description:
        "Save a finished code review so the user can triage it in review-app. Call once at the end of a review with ALL findings. Returns the review id and the URL to show the user.",
      inputSchema: submitReviewShape,
    },
    async (input) => {
      try {
        const review = await store.create(input);
        return ok({ reviewId: review.id, url: `${getBaseUrl()}/r/${review.id}`, counts: countBySeverity(review.findings) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_pending_actions",
    {
      title: "Get pending review actions",
      description:
        "Returns the findings the user marked 'Fix' in review-app (with their notes) and marks them as 'fixing'. Omit reviewId to use the most recent review. After fixing each one, call mark_done.",
      inputSchema: { reviewId: z.string().optional().describe("Review id, e.g. r_8f3k2a. Omit for the latest review.") },
    },
    async ({ reviewId }) => {
      try {
        const { review, findings } = await store.takePending(reviewId);
        const actions = await Promise.all(
          findings.map(async (f) => {
            const a = await anchorFinding(review.repoRoot, f);
            return {
              findingId: f.id,
              severity: f.severity,
              title: f.title,
              body: f.body,
              suggestion: f.suggestion,
              file: f.file,
              lineStart: a.lineStart,
              lineEnd: a.lineEnd,
              anchor: a.exists ? a.anchor : "file-missing",
              snippet: f.snippet,
              myNote: f.myNote,
            };
          }),
        );
        return ok({
          reviewId: review.id,
          repoRoot: review.repoRoot,
          actions,
          ...(actions.length === 0
            ? { message: "Nothing pending. Ask the user to mark findings with 'Fix' in review-app first." }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "mark_done",
    {
      title: "Report a finding as handled",
      description: "Call after handling each pending action: outcome 'fixed' with a one-sentence note of what changed, or 'skipped' with why.",
      inputSchema: {
        reviewId: z.string(),
        findingId: z.string(),
        outcome: z.enum(["fixed", "skipped"]),
        note: z.string().min(1).describe("One sentence for the user"),
      },
    },
    async ({ reviewId, findingId, outcome, note }) => {
      try {
        await store.updateFinding(reviewId, findingId, { status: outcome, resolution: note });
        return ok({ ok: true, remaining: store.countFixing(reviewId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh MCP server + transport per POST, as in the SDK's stateless example. */
export function mountMcp(app: express.Express, store: ReviewStore, getBaseUrl: () => string): void {
  app.post("/mcp", express.json({ limit: "5mb" }), async (req, res) => {
    const server = buildMcpServer(store, getBaseUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("review-app: MCP request failed", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  const notAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
```

- [ ] **Step 4: Mount it in `src/server/index.ts`**

Add the import:

```ts
import { mountMcp } from "./mcp";
```

In `createApp`, directly after `app.use("/api", createApiRouter(opts.store));`, add:

```ts
  mountMcp(app, opts.store, () => `http://${HOST}:${opts.getPort()}`);
```

(It must come before the `uiDir` catch-all `app.get("*")`, otherwise `GET /mcp` would serve `index.html`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server`
Expected: PASS (all server suites).

If `registerTool` doesn't exist in the installed SDK version (pre-1.11), run `npm ls @modelcontextprotocol/sdk` and upgrade with `npm install @modelcontextprotocol/sdk@^1.17`. Don't rewrite to the older `server.tool()` API.

- [ ] **Step 6: Commit checkpoint**

Files: `src/server/mcp.ts src/server/index.ts tests/server/mcp.test.ts`. Suggested message: `Add MCP tools`

---

### Task 7: CLI, setup command and Claude Code skills

**Files:**
- Create: `src/cli/index.ts`, `src/cli/setup.ts`, `tsup.config.ts`
- Create: `skills/ai-review/SKILL.md`, `skills/apply-review/SKILL.md`
- Test: `tests/cli/setup.test.ts`

**Interfaces:**
- Consumes: `startServer` (Task 5)
- Produces:
  - `findPackageDir(fromFile: string): string`
  - `SKILL_NAMES = ["ai-review", "apply-review"] as const`
  - `installSkills(srcDir: string, claudeHome: string): Promise<string[]>` (returns the installed dirs)
  - `registerMcp(url: string): Promise<{ ok: boolean; output: string }>`
  - CLI: `review-app start` (default) and `review-app setup`

- [ ] **Step 1: Write the skills**

`skills/ai-review/SKILL.md`:

```markdown
---
name: ai-review
description: Review local code — uncommitted changes, or specific files/folders — and send structured findings to review-app for triage. Use when the user runs /ai-review or asks to review code "into review-app".
---

# AI review → review-app

You are reviewing code and delivering the result to **review-app** (MCP server `review-app`, tool `submit_review`). The user reads and triages findings in the app, NOT in this chat. Do not modify any code during a review.

## 1. Scope

- Find the repo root: `git rev-parse --show-toplevel` (if not a git repo, use the current working directory). Use the absolute path as `repoRoot`.
- **No paths given after /ai-review:** review uncommitted changes. Get them with `git diff HEAD` and `git ls-files --others --exclude-standard`. Scope = `{ "kind": "diff", "target": "uncommitted" }`. If there are no changes, tell the user and stop.
- **Paths given:** review those files/folders completely (recurse into folders; skip `node_modules`, `dist`, `build`, lock files, generated and binary files). Scope = `{ "kind": "files", "target": [<paths as given>] }`.
- Read whole files for context, not just diff hunks. For a diff review, report issues in the changed code or issues the change causes.

## 2. What to look for

Bugs, security problems, performance issues, and maintainability problems. Only report issues you can point to concrete lines. Prefer fewer, well-grounded findings over many weak ones (at most ~25).

## 3. Severity rules (use exactly these values)

- `critical`: security vulnerability, data loss/corruption, crash on a main path.
- `high`: likely bug, broken edge case, race condition.
- `medium`: risky pattern, weak error handling, maintainability problem.
- `low`: naming, style, small cleanups.

## 4. Each finding

- `title`: one line, states the problem ("Expired sessions are still accepted").
- `body`: markdown. What is wrong, why it matters, and a concrete failure scenario (inputs/state → wrong result).
- `suggestion` (optional): the fix, in words or a short code block.
- `category`: `bug | security | performance | maintainability | style | other`.
- `file`: repo-relative, forward slashes.
- `lineStart`/`lineEnd`: 1-based line numbers in the file **as it is now on disk**.
- `snippet`: the exact text of lines `lineStart..lineEnd`, copied from the file without line-number prefixes. This is used to re-find the lines if the file changes, so it must match.

## 5. Submit

Call `submit_review` with `repoRoot`, `scope`, a one-paragraph `summary`, and all `findings`.

- If the tool returns a validation error, fix the offending fields and call it again.
- If the `review-app` tool is unavailable or the connection fails: tell the user "review-app isn't running. Start it with `review-app` in a terminal, then tell me to retry." Keep the findings and resubmit when asked.

## 6. Reply

Reply with ONE line only, using the counts and url from the tool result:

`Review r_xxxxxx: 🔴 2 · 🟠 3 · 🟡 4 · 🟢 3 → http://127.0.0.1:4477/r/r_xxxxxx`

Do not list or repeat the findings in chat.
```

`skills/apply-review/SKILL.md`:

```markdown
---
name: apply-review
description: Apply the fixes the user selected in review-app. Use when the user runs /apply-review (optionally with a review id like r_8f3k2a) or says "apply my review decisions".
---

# Apply review decisions from review-app

1. Call the `review-app` MCP tool `get_pending_actions`. Pass `reviewId` if the user gave one (e.g. `/apply-review r_8f3k2a`); otherwise omit it.
2. If `actions` is empty, tell the user there is nothing marked for fixing and stop.
3. For each action, in the order given:
   - Open `file` around `lineStart..lineEnd` (paths are relative to `repoRoot`).
     - `anchor: "lost"`: the code moved or changed. Locate it from `snippet` and the description. If you cannot find it, skip it.
     - `anchor: "file-missing"`: skip it.
   - Make the **smallest change** that resolves the problem described in `body`. Follow `suggestion` unless `myNote` says otherwise. **`myNote` is the user's instruction and overrides everything else.** Do not fix unrelated things.
   - Call `mark_done` right away with `outcome: "fixed"` and a one-sentence `note` saying what you changed, or `outcome: "skipped"` and a one-sentence reason.
4. Finish with a short summary: "Fixed N, skipped M", plus one line per finding.

Do not commit. The user reviews the changes and commits.
```

- [ ] **Step 2: Write the failing test** `tests/cli/setup.test.ts`

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findPackageDir, installSkills, SKILL_NAMES } from "../../src/cli/setup";
import { tmpDir } from "../helpers";

const pkgDir = findPackageDir(fileURLToPath(import.meta.url));

describe("findPackageDir", () => {
  it("finds the review-app package root", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("review-app");
  });
});

describe("skills", () => {
  it.each(SKILL_NAMES)("%s has matching frontmatter name and references the MCP tools", async (name) => {
    const text = await fs.readFile(path.join(pkgDir, "skills", name, "SKILL.md"), "utf8");
    expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`, "m"));
    const tools = name === "ai-review" ? ["submit_review"] : ["get_pending_actions", "mark_done"];
    for (const t of tools) expect(text).toContain(t);
  });
});

describe("installSkills", () => {
  it("copies each SKILL.md into <claudeHome>/skills/<name>/, overwriting old versions", async () => {
    const claudeHome = await tmpDir("review-app-claude-");
    await fs.mkdir(path.join(claudeHome, "skills", "ai-review"), { recursive: true });
    await fs.writeFile(path.join(claudeHome, "skills", "ai-review", "SKILL.md"), "old");

    const dirs = await installSkills(path.join(pkgDir, "skills"), claudeHome);

    expect(dirs).toEqual(SKILL_NAMES.map((n) => path.join(claudeHome, "skills", n)));
    for (const n of SKILL_NAMES) {
      const installed = await fs.readFile(path.join(claudeHome, "skills", n, "SKILL.md"), "utf8");
      expect(installed).toContain(`name: ${n}`);
    }
  });
});
```

Note: if Git converts the SKILL.md files to CRLF on checkout, the `^---\nname:` regex fails. In that case add `skills/** text eol=lf` to a new `.gitattributes`. Don't loosen the test.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/cli`
Expected: FAIL. Cannot find module `../../src/cli/setup`.

- [ ] **Step 4: Implement `src/cli/setup.ts`**

```ts
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

export const SKILL_NAMES = ["ai-review", "apply-review"] as const;

/** Walks up from a file to the nearest directory containing package.json (works from src/ and from dist/). */
export function findPackageDir(fromFile: string): string {
  let dir = path.dirname(fromFile);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${fromFile}`);
    dir = parent;
  }
}

export async function installSkills(srcDir: string, claudeHome: string): Promise<string[]> {
  const installed: string[] = [];
  for (const name of SKILL_NAMES) {
    const dest = path.join(claudeHome, "skills", name);
    await fs.mkdir(dest, { recursive: true });
    await fs.copyFile(path.join(srcDir, name, "SKILL.md"), path.join(dest, "SKILL.md"));
    installed.push(dest);
  }
  return installed;
}

export function registerMcp(url: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["mcp", "add", "--transport", "http", "--scope", "user", "review-app", url],
      { shell: process.platform === "win32" }, // `claude` is a .cmd shim on Windows
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.trim() }),
    );
  });
}
```

- [ ] **Step 5: Implement `src/cli/index.ts`**

```ts
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/index";
import { findPackageDir, installSkills, registerMcp } from "./setup";

const PORT = 4477;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "start";
  const pkgDir = findPackageDir(fileURLToPath(import.meta.url));

  if (cmd === "start") {
    const uiDir = path.join(pkgDir, "dist", "ui");
    try {
      const s = await startServer({ port: PORT, uiDir: existsSync(path.join(uiDir, "index.html")) ? uiDir : undefined });
      console.log(`review-app running at ${s.url}\nMCP endpoint: ${s.url}/mcp\nPress Ctrl+C to stop.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(`Port ${PORT} is busy. Is review-app already running? Open http://127.0.0.1:${PORT}`);
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  if (cmd === "setup") {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    for (const dir of await installSkills(path.join(pkgDir, "skills"), claudeHome)) console.log(`Installed skill: ${dir}`);
    const url = `http://127.0.0.1:${PORT}/mcp`;
    const res = await registerMcp(url);
    if (res.ok) {
      console.log("Registered MCP server 'review-app' with Claude Code (user scope).");
    } else {
      console.log(
        `Could not register the MCP server automatically${res.output ? `:\n${res.output}` : "."}\n` +
          `If it is already registered, ignore this. Otherwise run:\n  claude mcp add --transport http --scope user review-app ${url}`,
      );
    }
    return;
  }

  console.log("Usage: review-app [start|setup]");
  process.exit(1);
}

void main();
```

- [ ] **Step 6: Create `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: false, // dist/ui is produced by `vite build` first
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
```

- [ ] **Step 7: Run tests and smoke-test the dev server**

Run: `npx vitest run tests/cli`
Expected: PASS.

Run: `npx tsx src/cli/index.ts start` in a second terminal, then `curl http://127.0.0.1:4477/api/reviews`.
Expected: the server prints `review-app running at http://127.0.0.1:4477` and curl returns `[]` or a list. Stop the server with Ctrl+C.

- [ ] **Step 8: Commit checkpoint**

Files: `src/cli skills tsup.config.ts tests/cli` (plus `.gitattributes` if added). Suggested message: `Add CLI, setup and Claude skills`

---

### Task 8: Findings list component

**Files:**
- Create: `src/ui/components/FindingsList.tsx`
- Test: `tests/ui/FindingsList.test.tsx`

**Interfaces:**
- Consumes: `listView`, `Filters`, `StatusFilter`, `SEVERITY_ICON`, `SEVERITY_LABEL` (Task 2); `Finding`, `FindingStatus`, `SEVERITIES` (Task 1)
- Produces: `FindingsList(props: { findings: Finding[]; filters: Filters; onFiltersChange(f: Filters): void; selectedId: string | null; onSelect(id: string): void; doneOpen: boolean; onToggleDone(): void })`. Each row is a `button` with `data-testid="finding-row"`. The done toggle is a button with text `Done (N)`.

- [ ] **Step 1: Write the failing test** `tests/ui/FindingsList.test.tsx`

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FindingsList } from "../../src/ui/components/FindingsList";
import type { Filters } from "../../src/shared/findings";
import { SEVERITIES } from "../../src/shared/schema";
import { makeFinding } from "../helpers";

afterEach(cleanup);

const all: Filters = { severities: [...SEVERITIES], status: "all" };
const findings = [
  makeFinding({ id: "low", severity: "low", title: "Rename var", file: "a.ts", lineStart: 3 }),
  makeFinding({ id: "crit", severity: "critical", title: "SQL injection", file: "db.ts", lineStart: 88 }),
  makeFinding({ id: "fixed", severity: "high", title: "Already fixed", status: "fixed" }),
  makeFinding({ id: "dis", severity: "medium", title: "Not relevant", status: "dismissed" }),
];

function setup(over: Partial<Parameters<typeof FindingsList>[0]> = {}) {
  const props = {
    findings, filters: all, onFiltersChange: vi.fn(), selectedId: null, onSelect: vi.fn(),
    doneOpen: false, onToggleDone: vi.fn(), ...over,
  };
  render(<FindingsList {...props} />);
  return props;
}

describe("FindingsList", () => {
  it("shows active findings critical first, with file:line", () => {
    setup();
    const rows = screen.getAllByTestId("finding-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("SQL injection"),
      expect.stringContaining("Rename var"),
    ]);
    expect(rows[0].textContent).toContain("db.ts:88");
  });

  it("calls onSelect with the finding id", async () => {
    const p = setup();
    await userEvent.click(screen.getByText("SQL injection"));
    expect(p.onSelect).toHaveBeenCalledWith("crit");
  });

  it("marks the selected row", () => {
    setup({ selectedId: "low" });
    const row = screen.getByText("Rename var").closest("button")!;
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("collapses the done group and toggles it", async () => {
    const p = setup();
    expect(screen.queryByText("Already fixed")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Done \(2\)/ }));
    expect(p.onToggleDone).toHaveBeenCalled();
  });

  it("shows done findings when the group is open", () => {
    setup({ doneOpen: true });
    expect(screen.getByText("Already fixed")).toBeTruthy();
    expect(screen.getByText("Not relevant")).toBeTruthy();
  });

  it("toggling a severity chip removes it from the filter", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: /Low/ }));
    expect(p.onFiltersChange).toHaveBeenCalledWith({ ...all, severities: ["critical", "high", "medium"] });
  });

  it("shows an empty message when nothing matches", () => {
    setup({ filters: { severities: [], status: "all" } });
    expect(screen.getByText(/No findings match/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/FindingsList.test.tsx`
Expected: FAIL. Cannot find module `../../src/ui/components/FindingsList`.

- [ ] **Step 3: Implement `src/ui/components/FindingsList.tsx`**

```tsx
import { listView, SEVERITY_ICON, SEVERITY_LABEL, type Filters, type StatusFilter } from "../../shared/findings";
import { SEVERITIES, type Finding, type FindingStatus, type Severity } from "../../shared/schema";

interface Props {
  findings: Finding[];
  filters: Filters;
  onFiltersChange(f: Filters): void;
  selectedId: string | null;
  onSelect(id: string): void;
  doneOpen: boolean;
  onToggleDone(): void;
}

const STATUS_BADGE: Record<FindingStatus, string> = {
  open: "",
  fix_requested: "Fix ✓",
  fixing: "Fixing…",
  fixed: "✅ Fixed",
  skipped: "⏭ Skipped",
  dismissed: "✕ Dismissed",
};

export function FindingsList(p: Props) {
  const { active, done } = listView(p.findings, p.filters);
  const showDone = p.doneOpen || p.filters.status === "done";

  const toggleSeverity = (s: Severity) => {
    const has = p.filters.severities.includes(s);
    p.onFiltersChange({
      ...p.filters,
      severities: has ? p.filters.severities.filter((x) => x !== s) : SEVERITIES.filter((x) => x === s || p.filters.severities.includes(x)),
    });
  };

  return (
    <aside className="list">
      <div className="filters">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            className={`chip sev-${s}`}
            aria-pressed={p.filters.severities.includes(s)}
            onClick={() => toggleSeverity(s)}
          >
            {SEVERITY_ICON[s]} {SEVERITY_LABEL[s]}
          </button>
        ))}
        <select
          aria-label="Status filter"
          value={p.filters.status}
          onChange={(e) => p.onFiltersChange({ ...p.filters, status: e.target.value as StatusFilter })}
        >
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </select>
      </div>

      {active.length === 0 && done.length === 0 && <p className="empty muted">No findings match the filters.</p>}

      <ul>
        {active.map((f) => (
          <Row key={f.id} f={f} selected={f.id === p.selectedId} onSelect={p.onSelect} />
        ))}
      </ul>

      {done.length > 0 && (
        <>
          <button className="done-toggle" aria-expanded={showDone} onClick={p.onToggleDone}>
            {showDone ? "▾" : "▸"} Done ({done.length})
          </button>
          {showDone && (
            <ul>
              {done.map((f) => (
                <Row key={f.id} f={f} selected={f.id === p.selectedId} onSelect={p.onSelect} />
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

function Row({ f, selected, onSelect }: { f: Finding; selected: boolean; onSelect(id: string): void }) {
  const badge = STATUS_BADGE[f.status];
  return (
    <li>
      <button
        className={`row sev-${f.severity}${selected ? " selected" : ""}`}
        data-testid="finding-row"
        aria-current={selected ? true : undefined}
        onClick={() => onSelect(f.id)}
      >
        <span className="sev-bar" aria-hidden="true" />
        <span className="row-main">
          <span className="row-title">{f.title}</span>
          <span className="row-loc">
            {f.file}:{f.lineStart}
          </span>
        </span>
        {badge && <span className={`badge status-${f.status}`}>{badge}</span>}
      </button>
    </li>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ui/FindingsList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

Files: `src/ui/components/FindingsList.tsx tests/ui/FindingsList.test.tsx`. Suggested message: `Add findings list component`

---

### Task 9: Comment card component

**Files:**
- Create: `src/ui/components/CommentCard.tsx`
- Test: `tests/ui/CommentCard.test.tsx`

**Interfaces:**
- Consumes: `Finding`, `FindingPatch`, `Severity`, `SEVERITIES` (Task 1); `SEVERITY_ICON`, `SEVERITY_LABEL` (Task 2); `Anchor` (Task 2)
- Produces: `CommentCard(props: { finding: Finding; anchor: Anchor["anchor"] | "missing"; onUpdate(patch: FindingPatch): void; noteRef?: React.Ref<HTMLTextAreaElement> })`. The root has `data-testid="comment-card"`.

- [ ] **Step 1: Write the failing test** `tests/ui/CommentCard.test.tsx`

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentCard } from "../../src/ui/components/CommentCard";
import type { Finding } from "../../src/shared/schema";
import { makeFinding } from "../helpers";

afterEach(cleanup);

function setup(f: Partial<Finding> = {}, anchor: "exact" | "moved" | "lost" | "missing" = "exact") {
  const onUpdate = vi.fn();
  const finding = makeFinding({
    severity: "critical", category: "security", title: "Token never expires",
    body: "Sessions are **never** checked.", suggestion: "Check `expiresAt`.", snippet: "return s.user", ...f,
  });
  render(<CommentCard finding={finding} anchor={anchor} onUpdate={onUpdate} />);
  return onUpdate;
}

describe("CommentCard", () => {
  it("shows severity, category, title, markdown body and suggestion", () => {
    setup();
    expect(screen.getByText(/CRITICAL/)).toBeTruthy();
    expect(screen.getByText(/security/)).toBeTruthy();
    expect(screen.getByText("Token never expires")).toBeTruthy();
    expect(screen.getByText("never").tagName).toBe("STRONG");
    expect(screen.getByText("expiresAt").tagName).toBe("CODE");
  });

  it("Fix toggles fix_requested on and off", async () => {
    const onUpdate = setup();
    await userEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ status: "fix_requested" });
    cleanup();

    const onUpdate2 = setup({ status: "fix_requested" });
    await userEvent.click(screen.getByRole("button", { name: /Fix requested/ }));
    expect(onUpdate2).toHaveBeenLastCalledWith({ status: "open" });
  });

  it("Dismiss sets dismissed", async () => {
    const onUpdate = setup();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onUpdate).toHaveBeenCalledWith({ status: "dismissed" });
  });

  it("changing severity sends the new severity and shows Claude's original", async () => {
    const onUpdate = setup();
    await userEvent.selectOptions(screen.getByLabelText(/Severity/), "low");
    expect(onUpdate).toHaveBeenCalledWith({ severity: "low" });
    cleanup();
    setup({ severity: "low", originalSeverity: "critical" });
    expect(screen.getByText(/Claude said Critical/)).toBeTruthy();
  });

  it("saves the note on blur only when it changed", async () => {
    const onUpdate = setup();
    const note = screen.getByLabelText("Note to Claude");
    await userEvent.click(note);
    await userEvent.tab();
    expect(onUpdate).not.toHaveBeenCalled();
    await userEvent.type(note, "keep API");
    await userEvent.tab();
    expect(onUpdate).toHaveBeenCalledWith({ myNote: "keep API" });
  });

  it("while fixing: no Fix/Dismiss, offers Reset to open", async () => {
    const onUpdate = setup({ status: "fixing" });
    expect(screen.queryByRole("button", { name: "Fix" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reset to open" }));
    expect(onUpdate).toHaveBeenCalledWith({ status: "open" });
  });

  it("shows Claude's resolution", () => {
    setup({ status: "fixed", resolution: "Added expiry check" });
    expect(screen.getByText("Added expiry check")).toBeTruthy();
  });

  it("warns and shows the original snippet when the anchor is lost or the file is missing", () => {
    setup({}, "lost");
    expect(screen.getByText(/code changed since review/)).toBeTruthy();
    expect(screen.getByText("return s.user")).toBeTruthy();
    cleanup();
    setup({}, "missing");
    expect(screen.getByText(/file no longer exists/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/CommentCard.test.tsx`
Expected: FAIL. Cannot find module `../../src/ui/components/CommentCard`.

- [ ] **Step 3: Implement `src/ui/components/CommentCard.tsx`**

```tsx
import { useEffect, useState, type Ref } from "react";
import Markdown from "react-markdown";
import type { Anchor } from "../../shared/api-types";
import { SEVERITY_ICON, SEVERITY_LABEL } from "../../shared/findings";
import { SEVERITIES, type Finding, type FindingPatch, type Severity } from "../../shared/schema";

interface Props {
  finding: Finding;
  anchor: Anchor["anchor"] | "missing";
  onUpdate(patch: FindingPatch): void;
  noteRef?: Ref<HTMLTextAreaElement>;
}

export function CommentCard({ finding: f, anchor, onUpdate, noteRef }: Props) {
  const [note, setNote] = useState(f.myNote ?? "");
  useEffect(() => setNote(f.myNote ?? ""), [f.id, f.myNote]);

  const actionable = f.status === "open" || f.status === "fix_requested";
  const resettable = f.status === "fixing" || f.status === "skipped" || f.status === "dismissed";
  const noteId = `note-${f.id}`;
  const sevId = `sev-${f.id}`;

  return (
    <div className={`card sev-${f.severity}`} data-testid="comment-card">
      <div className="card-head">
        <span className={`sev-label sev-${f.severity}`}>
          {SEVERITY_ICON[f.severity]} {SEVERITY_LABEL[f.severity].toUpperCase()}
        </span>
        <span className="muted"> · {f.category}</span>
        {f.severity !== f.originalSeverity && (
          <span className="muted"> (Claude said {SEVERITY_LABEL[f.originalSeverity]})</span>
        )}
      </div>
      <h3 className="card-title">{f.title}</h3>

      {anchor === "lost" && <p className="warn">⚠ code changed since review. Original snippet:</p>}
      {anchor === "missing" && <p className="warn">⚠ file no longer exists. Original snippet:</p>}
      {(anchor === "lost" || anchor === "missing") && <pre className="snippet">{f.snippet}</pre>}

      <div className="md">
        <Markdown>{f.body}</Markdown>
      </div>

      {f.suggestion && (
        <div className="suggestion">
          <div className="label">Suggestion</div>
          <div className="md">
            <Markdown>{f.suggestion}</Markdown>
          </div>
        </div>
      )}

      {f.resolution && (
        <div className="resolution">
          <div className="label">Claude</div>
          <p>{f.resolution}</p>
        </div>
      )}

      <label className="label" htmlFor={noteId}>
        Note to Claude
      </label>
      <textarea
        id={noteId}
        ref={noteRef}
        rows={2}
        value={note}
        placeholder="e.g. fix it, but keep the public API"
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== (f.myNote ?? "")) onUpdate({ myNote: note });
        }}
      />

      <div className="actions">
        {actionable && (
          <button
            className={`btn fix${f.status === "fix_requested" ? " on" : ""}`}
            onClick={() => onUpdate({ status: f.status === "fix_requested" ? "open" : "fix_requested" })}
          >
            {f.status === "fix_requested" ? "Fix requested ✓" : "Fix"}
          </button>
        )}
        {actionable && (
          <button className="btn" onClick={() => onUpdate({ status: "dismissed" })}>
            Dismiss
          </button>
        )}
        {resettable && (
          <button className="btn" onClick={() => onUpdate({ status: "open" })}>
            Reset to open
          </button>
        )}
        <span className="sev-select">
          <label htmlFor={sevId}>Severity</label>
          <select id={sevId} value={f.severity} onChange={(e) => onUpdate({ severity: e.target.value as Severity })}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ui`
Expected: PASS (both UI suites).

- [ ] **Step 5: Commit checkpoint**

Files: `src/ui/components/CommentCard.tsx tests/ui/CommentCard.test.tsx`. Suggested message: `Add comment card component`

---

### Task 10: UI shell: code view, header, app wiring and styles

**Files:**
- Create: `vite.config.ts`, `src/ui/index.html`, `src/ui/main.tsx`, `src/ui/App.tsx`, `src/ui/api.ts`, `src/ui/highlight.ts`, `src/ui/styles.css`
- Create: `src/ui/components/Header.tsx`, `src/ui/components/CodeView.tsx`
- Create: `scripts/seed.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2 and 8–9; the REST/SSE contract from Task 5; `submit_review` from Task 6
- Produces: the runnable UI. Verified with typecheck, build and a manual run (component logic is already unit-tested in Tasks 8–9; Shiki rendering is checked by eye).

- [ ] **Step 1: Create `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  build: { outDir: "../../dist/ui", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4477", changeOrigin: true },
      "/mcp": { target: "http://127.0.0.1:4477", changeOrigin: true },
    },
  },
});
```

- [ ] **Step 2: Create `src/ui/index.html` and `src/ui/main.tsx`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>review-app</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 3: Create `src/ui/api.ts`**

```ts
import type { FileResponse, ReviewSummary, StoreEvent } from "../shared/api-types";
import type { Finding, FindingPatch, Review } from "../shared/schema";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const fetchReviews = () => fetch("/api/reviews").then((r) => json<ReviewSummary[]>(r));

export const fetchReview = (id: string) => fetch(`/api/reviews/${enc(id)}`).then((r) => json<Review>(r));

export const fetchFile = (id: string, path: string) =>
  fetch(`/api/reviews/${enc(id)}/file?path=${enc(path)}`).then((r) => json<FileResponse>(r));

export const patchFinding = (id: string, findingId: string, patch: FindingPatch) =>
  fetch(`/api/reviews/${enc(id)}/findings/${enc(findingId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => json<Finding>(r));

/** Live updates from the server. EventSource reconnects by itself if the server restarts. */
export function subscribe(onEvent: (e: StoreEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as StoreEvent);
  return () => es.close();
}
```

- [ ] **Step 4: Create `src/ui/highlight.ts`**

```ts
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";

export type Tok = { content: string; color?: string };

const THEME = "github-dark-default";

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", cs: "csharp",
  rb: "ruby", php: "php", css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
  md: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", sql: "sql", c: "c", h: "c",
  cpp: "cpp", hpp: "cpp", swift: "swift", xml: "xml", toml: "toml",
};

export function langFromPath(p: string): BundledLanguage | "text" {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT[ext];
  return lang && lang in bundledLanguages ? (lang as BundledLanguage) : "text";
}

let highlighter: Promise<Highlighter> | null = null;

/** One token array per line. Languages are loaded on first use. */
export async function highlight(code: string, filePath: string): Promise<Tok[][]> {
  highlighter ??= createHighlighter({ themes: [THEME], langs: [] });
  const h = await highlighter;
  const lang = langFromPath(filePath);
  if (lang !== "text" && !h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
  const lines = h.codeToTokensBase(code.replace(/\r\n/g, "\n"), { lang, theme: THEME });
  return lines.map((line) => line.map((t) => ({ content: t.content, color: t.color })));
}
```

- [ ] **Step 5: Create `src/ui/components/Header.tsx`**

```tsx
import type { ReviewSummary } from "../../shared/api-types";
import { countBySeverity, scopeLabel, SEVERITY_ICON } from "../../shared/findings";
import { repoName } from "../../shared/paths";
import { SEVERITIES, type Review } from "../../shared/schema";

interface Props {
  reviews: ReviewSummary[];
  review: Review | null;
  pendingCount: number;
  onSwitch(id: string): void;
  onSend(): void;
}

export function Header({ reviews, review, pendingCount, onSwitch, onSend }: Props) {
  const counts = review ? countBySeverity(review.findings) : null;
  return (
    <header className="header">
      <div className="header-title">
        <strong>review-app</strong>
        {review && (
          <span className="muted" title={review.summary}>
            {repoName(review.repoRoot)} · {scopeLabel(review.scope)} · {review.findings.length} findings
          </span>
        )}
      </div>
      {counts && (
        <div className="counts">
          {SEVERITIES.map((s) => (
            <span key={s} className={`count sev-${s}`}>
              {SEVERITY_ICON[s]} {counts[s]}
            </span>
          ))}
        </div>
      )}
      {reviews.length > 0 && (
        <select aria-label="Switch review" value={review?.id ?? ""} onChange={(e) => onSwitch(e.target.value)}>
          {reviews.map((r) => (
            <option key={r.id} value={r.id}>
              {r.repoName} · {scopeLabel(r.scope)} · {new Date(r.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
      )}
      <button className="send" disabled={pendingCount === 0} onClick={onSend}>
        Send {pendingCount} to Claude ▶
      </button>
    </header>
  );
}
```

- [ ] **Step 6: Create `src/ui/components/CodeView.tsx`**

```tsx
import { Fragment, useEffect, useRef, useState, type Ref } from "react";
import type { Anchor, FileResponse } from "../../shared/api-types";
import { vscodeUrl } from "../../shared/paths";
import type { Finding, FindingPatch, Review } from "../../shared/schema";
import { fetchFile } from "../api";
import { highlight, type Tok } from "../highlight";
import { CommentCard } from "./CommentCard";

interface Props {
  review: Review;
  finding: Finding;
  onSelect(id: string): void;
  onUpdate(findingId: string, patch: FindingPatch): void;
  noteRef: Ref<HTMLTextAreaElement>;
}

export function CodeView({ review, finding, onSelect, onUpdate, noteRef }: Props) {
  const [file, setFile] = useState<FileResponse | null>(null);
  const [tokens, setTokens] = useState<Tok[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);

  // New file → clear old content so tokens of one file never render over another.
  useEffect(() => {
    setFile(null);
    setTokens(null);
  }, [review.id, finding.file]);

  // (Re)load whenever the review changes too, so fixes made by Claude show up.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchFile(review.id, finding.file)
      .then((res) => {
        if (cancelled) return;
        setFile(res);
        if (res.exists) {
          highlight(res.content, finding.file)
            .then((t) => !cancelled && setTokens(t))
            .catch(() => {}); // plain text fallback stays
        }
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [review, finding.file]);

  const anchor: Anchor | undefined = file?.exists ? file.anchors[finding.id] : undefined;

  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [finding.id, anchor?.lineStart, file?.exists]);

  const href = vscodeUrl(review.repoRoot, finding.file, anchor?.lineStart ?? finding.lineStart);
  const head = (
    <div className="code-head">
      <span className="path">{finding.file}</span>
      <a className="btn" href={href}>
        Open in VS Code
      </a>
    </div>
  );
  const card = (state: Anchor["anchor"] | "missing") => (
    <CommentCard key={finding.id} finding={finding} anchor={state} onUpdate={(p) => onUpdate(finding.id, p)} noteRef={noteRef} />
  );

  if (error) {
    return (
      <section className="code">
        {head}
        <p className="warn pad">Could not load file: {error}</p>
      </section>
    );
  }
  if (!file) {
    return (
      <section className="code">
        {head}
        <p className="muted pad">Loading…</p>
      </section>
    );
  }
  if (!file.exists) {
    return (
      <section className="code">
        {head}
        <div className="code-body" ref={targetRef}>
          {card("missing")}
        </div>
      </section>
    );
  }

  const lines: Tok[][] = tokens ?? file.content.replace(/\r\n/g, "\n").split("\n").map((l) => [{ content: l }]);
  const changed = new Set(file.changedLines);
  const dotsByLine = new Map<number, Finding[]>();
  for (const f of review.findings) {
    const a = file.anchors[f.id];
    if (f.file !== finding.file || !a || a.anchor === "lost") continue;
    dotsByLine.set(a.lineStart, [...(dotsByLine.get(a.lineStart) ?? []), f]);
  }
  const range = anchor && anchor.anchor !== "lost" ? anchor : null;

  return (
    <section className="code">
      {head}
      <div className="code-body">
        {!range && <div ref={targetRef}>{card("lost")}</div>}
        {lines.map((toks, i) => {
          const n = i + 1;
          const hl = range !== null && n >= range.lineStart && n <= range.lineEnd;
          return (
            <Fragment key={n}>
              <div
                className={`line${hl ? ` hl sev-${finding.severity}` : ""}`}
                ref={range && n === range.lineStart ? targetRef : undefined}
              >
                <span className={`chg${changed.has(n) ? " on" : ""}`} />
                <span className="dots">
                  {(dotsByLine.get(n) ?? []).map((d) => (
                    <button
                      key={d.id}
                      className={`dot sev-${d.severity}`}
                      title={d.title}
                      aria-label={`Finding: ${d.title}`}
                      onClick={() => onSelect(d.id)}
                    />
                  ))}
                </span>
                <span className="ln">{n}</span>
                <code className="src">
                  {toks.map((t, k) => (
                    <span key={k} style={t.color ? { color: t.color } : undefined}>
                      {t.content}
                    </span>
                  ))}
                </code>
              </div>
              {range && n === range.lineEnd && card(range.anchor)}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Create `src/ui/App.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewSummary } from "../shared/api-types";
import { navOrder, type Filters } from "../shared/findings";
import { SEVERITIES, type FindingPatch, type Review } from "../shared/schema";
import { fetchReview, fetchReviews, patchFinding, subscribe } from "./api";
import { CodeView } from "./components/CodeView";
import { FindingsList } from "./components/FindingsList";
import { Header } from "./components/Header";

function idFromUrl(): string | null {
  const m = location.pathname.match(/^\/r\/([\w-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(idFromUrl());
  const [review, setReview] = useState<Review | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ severities: [...SEVERITIES], status: "all" });
  const [doneOpen, setDoneOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reviewIdRef = useRef(reviewId);
  reviewIdRef.current = reviewId;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const loadReviews = useCallback(async () => {
    const list = await fetchReviews();
    setReviews(list);
    setReviewId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadReviews();
  }, [loadReviews]);

  useEffect(() => {
    if (!reviewId) return;
    if (location.pathname !== `/r/${reviewId}`) history.pushState(null, "", `/r/${reviewId}`);
    let cancelled = false;
    fetchReview(reviewId)
      .then((r) => !cancelled && setReview(r))
      .catch(() => !cancelled && setReview(null));
    return () => {
      cancelled = true;
    };
  }, [reviewId]);

  // Live updates: a new review jumps into view; changes to the open review refresh it.
  useEffect(
    () =>
      subscribe((e) => {
        void loadReviews();
        if (e.type === "review-created") {
          setSelectedId(null);
          setReviewId(e.reviewId);
        } else if (e.reviewId === reviewIdRef.current) {
          void fetchReview(e.reviewId).then(setReview);
        }
      }),
    [loadReviews],
  );

  useEffect(() => {
    const onPop = () => setReviewId(idFromUrl());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const nav = useMemo(() => (review ? navOrder(review.findings, filters, doneOpen) : []), [review, filters, doneOpen]);
  const selected = review?.findings.find((f) => f.id === selectedId) ?? null;

  useEffect(() => {
    if (review && !selected && nav.length > 0) setSelectedId(nav[0].id);
  }, [review, selected, nav]);

  const update = useCallback(
    async (findingId: string, patch: FindingPatch) => {
      if (!review) return;
      const id = review.id;
      try {
        const updated = await patchFinding(id, findingId, patch);
        setReview((r) => (r && r.id === id ? { ...r, findings: r.findings.map((f) => (f.id === findingId ? updated : f)) } : r));
      } catch (err) {
        showToast(`Update failed: ${(err as Error).message}`);
      }
    },
    [review, showToast],
  );

  const pendingCount = review?.findings.filter((f) => f.status === "fix_requested").length ?? 0;

  const onSend = async () => {
    if (!review) return;
    const text = `/apply-review ${review.id}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied. Paste it into Claude in VS Code.");
    } catch {
      showToast(`Copy failed. Type this into Claude: ${text}`);
    }
  };

  // Keyboard: j/k move, f fix, d dismiss, n note, Esc leaves the note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT") {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || nav.length === 0) return;
      const idx = nav.findIndex((f) => f.id === selectedId);
      if (e.key === "j") setSelectedId(nav[Math.min(idx + 1, nav.length - 1)].id);
      else if (e.key === "k") setSelectedId(nav[Math.max(idx - 1, 0)].id);
      else if (e.key === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (selected && (selected.status === "open" || selected.status === "fix_requested")) {
        if (e.key === "f") void update(selected.id, { status: selected.status === "fix_requested" ? "open" : "fix_requested" });
        else if (e.key === "d") void update(selected.id, { status: "dismissed" });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [nav, selectedId, selected, update]);

  return (
    <div className="app">
      <Header
        reviews={reviews}
        review={review}
        pendingCount={pendingCount}
        onSwitch={(id) => {
          setSelectedId(null);
          setReviewId(id);
        }}
        onSend={onSend}
      />
      {!review ? (
        <div className="welcome">
          {reviews.length === 0 ? (
            <>
              No reviews yet. Run <code>/ai-review</code> in Claude Code.
            </>
          ) : (
            "Loading…"
          )}
        </div>
      ) : (
        <div className="main">
          <FindingsList
            findings={review.findings}
            filters={filters}
            onFiltersChange={setFilters}
            selectedId={selectedId}
            onSelect={setSelectedId}
            doneOpen={doneOpen}
            onToggleDone={() => setDoneOpen((o) => !o)}
          />
          {selected ? (
            <CodeView review={review} finding={selected} onSelect={setSelectedId} onUpdate={update} noteRef={noteRef} />
          ) : (
            <div className="welcome">{review.findings.length === 0 ? "Clean review. No findings 🎉" : "Select a finding."}</div>
          )}
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Create `src/ui/styles.css`** (dark only)

```css
:root {
  color-scheme: dark;
  --bg: #0d1117;
  --panel: #161b22;
  --panel-2: #1c2128;
  --border: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
  --accent: #2f81f7;
  --critical: #f85149;
  --high: #f0883e;
  --medium: #d29922;
  --low: #3fb950;
  --mono: ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, "Segoe UI", sans-serif; }

.sev-critical { --sev: var(--critical); }
.sev-high { --sev: var(--high); }
.sev-medium { --sev: var(--medium); }
.sev-low { --sev: var(--low); }

.muted { color: var(--muted); }
.pad, .empty { padding: 16px; }
.welcome { padding: 40px; color: var(--muted); }
code { font-family: var(--mono); }

select, textarea, .btn, button.send {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; font: inherit;
}
select { padding: 4px 8px; }
.btn, button.send { padding: 5px 12px; cursor: pointer; text-decoration: none; display: inline-block; }
.btn:hover { border-color: var(--muted); }
button.send { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
button.send:disabled { background: var(--panel-2); border-color: var(--border); color: var(--muted); cursor: default; }

.app { display: grid; grid-template-rows: auto 1fr; height: 100%; }
.header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
.header-title { display: flex; gap: 10px; align-items: baseline; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.counts { display: flex; gap: 12px; white-space: nowrap; }

.main { display: grid; grid-template-columns: 360px 1fr; min-height: 0; }

.list { border-right: 1px solid var(--border); overflow-y: auto; background: var(--panel); }
.filters { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--panel); z-index: 1; }
.chip { background: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; cursor: pointer; font: inherit; font-size: 12px; }
.chip[aria-pressed="true"] { color: var(--text); border-color: var(--sev); }
.list ul { list-style: none; margin: 0; padding: 0; }
.row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--border); color: var(--text); padding: 10px 12px 10px 0; cursor: pointer; font: inherit; }
.row:hover { background: var(--panel-2); }
.row.selected { background: #1f2a3a; }
.sev-bar { align-self: stretch; width: 4px; flex: none; background: var(--sev); border-radius: 0 2px 2px 0; }
.row-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-loc { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; white-space: nowrap; }
.badge.status-fix_requested, .badge.status-fixing { color: var(--accent); border-color: var(--accent); }
.done-toggle { width: 100%; text-align: left; background: none; border: 0; color: var(--muted); padding: 10px 12px; cursor: pointer; font: inherit; }

.code { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.code-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
.path { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code-body { overflow: auto; flex: 1; font-family: var(--mono); font-size: 13px; padding: 8px 0 40vh; }
.line { display: flex; min-height: 20px; line-height: 20px; }
.line.hl { background: color-mix(in srgb, var(--sev) 16%, transparent); box-shadow: inset 3px 0 0 var(--sev); }
.chg { width: 3px; flex: none; }
.chg.on { background: var(--accent); opacity: 0.6; }
.dots { width: 22px; flex: none; display: flex; align-items: center; justify-content: center; gap: 2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; border: 0; padding: 0; background: var(--sev); cursor: pointer; }
.ln { width: 48px; flex: none; text-align: right; padding-right: 14px; color: var(--muted); user-select: none; }
.src { white-space: pre; }

.card { margin: 8px 16px 8px 73px; padding: 12px 14px; max-width: 900px; background: var(--panel); border: 1px solid var(--border); border-left: 4px solid var(--sev); border-radius: 6px; font: 14px/1.5 system-ui, "Segoe UI", sans-serif; white-space: normal; }
.sev-label { color: var(--sev); font-weight: 700; font-size: 12px; letter-spacing: 0.04em; }
.card-title { margin: 4px 0 8px; font-size: 15px; }
.md p { margin: 6px 0; }
.md code { background: var(--panel-2); padding: 1px 4px; border-radius: 4px; }
.md pre { background: var(--bg); padding: 8px; border-radius: 6px; overflow: auto; }
.md pre code { background: none; padding: 0; }
.label { display: block; color: var(--muted); font-size: 12px; margin-top: 10px; }
.snippet { background: var(--bg); padding: 8px; border-radius: 6px; overflow: auto; font-family: var(--mono); font-size: 12px; }
.warn { color: var(--medium); margin: 6px 0; }
textarea { width: 100%; padding: 6px 8px; resize: vertical; margin-top: 4px; }
.actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.btn.fix.on { border-color: var(--accent); color: var(--accent); }
.sev-select { margin-left: auto; color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }

.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--panel-2); border: 1px solid var(--border); padding: 8px 16px; border-radius: 6px; }
```

- [ ] **Step 9: Create `scripts/seed.ts`** (demo data pointing at real lines of this repo)

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repoRoot = process.cwd();

/** Locates `needle` in a file and returns a finding location with the exact snippet. */
async function at(file: string, needle: string, extraLines = 0) {
  const lines = (await fs.readFile(path.join(repoRoot, file), "utf8")).split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(needle));
  if (i === -1) throw new Error(`"${needle}" not found in ${file}`);
  return { file, lineStart: i + 1, lineEnd: i + 1 + extraLines, snippet: lines.slice(i, i + 1 + extraLines).join("\n") };
}

const client = new Client({ name: "seed", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4477/mcp")));
const result = await client.callTool({
  name: "submit_review",
  arguments: {
    repoRoot,
    scope: { kind: "files", target: ["src/server"] },
    summary: "Demo review generated by scripts/seed.ts",
    findings: [
      { severity: "critical", category: "security", title: "Demo: path check must cover junctions", body: "Demo finding so you can try the UI.", suggestion: "Keep the `realpath` check.", ...(await at("src/server/files.ts", "ensureInside(rootReal, real, rel)")) },
      { severity: "high", category: "bug", title: "Demo: concurrent pulls", body: "Two `/apply-review` runs at once could race.", ...(await at("src/server/store.ts", "async takePending", 1)) },
      { severity: "medium", category: "maintainability", title: "Demo: magic port number", body: "`4477` appears in several places.", ...(await at("src/server/index.ts", "opts.port ?? 4477")) },
      { severity: "low", category: "style", title: "Demo: comment wording", body: "Just a nit.", ...(await at("src/server/mcp.ts", "Stateless Streamable HTTP")) },
    ],
  },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
console.log((result as any).content[0].text);
await client.close();
```

- [ ] **Step 10: Typecheck, test and build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: all suites PASS.

Run: `npm run build`
Expected: `dist/ui/index.html` and `dist/cli.js` exist.

- [ ] **Step 11: Manual check**

1. `node dist/cli.js start`
2. In another terminal: `npm run seed`. It prints JSON with `reviewId` and `url`.
3. Open `http://127.0.0.1:4477`. Check:
   - The list shows 🔴 → 🟢 in order. Clicking a row shows the file with syntax colors, the lines highlighted in the severity color, and the comment card directly below them.
   - `j`/`k` move, `f` toggles Fix (badge "Fix ✓", header shows "Send 1 to Claude"), `d` dismisses (row moves into Done).
   - Change severity on the card. The list re-sorts and the card shows "(Claude said …)".
   - Type a note, click elsewhere, then reload the page. The note is still there.
   - "Open in VS Code" opens the file at the line.
   - "Send N to Claude" shows the toast, and the clipboard contains `/apply-review r_…`.
   - Run `npm run seed` again with the page open. The new review appears without a reload.
4. Stop the server.

- [ ] **Step 12: Commit checkpoint**

Files: `vite.config.ts src/ui scripts`. Suggested message: `Add review UI`

---

### Task 11: Install, end-to-end with Claude Code, README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write `README.md`**

````markdown
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
````

- [ ] **Step 2: Install for real**

Run: `npm run build`, `npm link`, `review-app setup`
Expected: two "Installed skill" lines and "Registered MCP server 'review-app'" (or the manual command if it was already registered).

Run: `claude mcp list`
Expected: `review-app` is listed with `http://127.0.0.1:4477/mcp`. Its status shows connected once the server is running.

- [ ] **Step 3: End-to-end with Claude Code**

1. `review-app` in a terminal.
2. In VS Code, open a small repo with some uncommitted changes and start a new Claude Code session (so it picks up the new skills and the MCP server).
3. Run `/ai-review`. Expected: Claude replies with one line containing counts and a URL, and the app shows the review live.
4. In the app, mark 1–2 findings with Fix, add a note on one, and click "Send N to Claude".
5. Paste into Claude. Expected: Claude calls `get_pending_actions`, edits the code, calls `mark_done` per finding, and the app shows ✅ with Claude's note. The code viewer shows the changed code.
6. Paste the same `/apply-review` again. Expected: "nothing marked for fixing".
7. Stop `review-app` and run `/ai-review`. Expected: Claude says review-app isn't running and offers to retry.

Report anything that differs. Prompt wording in the skills is the most likely thing to need tuning.

- [ ] **Step 4: Commit checkpoint**

Files: `README.md`. Suggested message: `Add README`
