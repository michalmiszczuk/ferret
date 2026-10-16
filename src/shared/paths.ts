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
