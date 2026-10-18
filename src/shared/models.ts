// Models a headless review can run on. Ids are passed to `claude -p --model`.
export interface ModelOption {
  id: string;
  label: string;
  hint: string;
  /** Oldest Claude Code CLI that accepts this model in print mode. */
  minCli?: string;
}

export const MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "Best for everyday, complex tasks", minCli: "2.1.280" },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "For your toughest challenges", minCli: "2.1.280" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "Most efficient for simpler tasks" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", hint: "Fastest for quick answers" },
];

export const DEFAULT_REVIEW_MODEL = "claude-opus-5-5";
export const DEFAULT_DRAFT_MODEL = "claude-sonnet-5-5";

/** Accepts our ids and anything alias-shaped (opus, claude-x-1-2, ...[1m]); never option-like. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

export function modelLabel(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

/** "2.1.139" < "2.1.280" → true. Non-numeric parts count as 0. */
export function versionBelow(version: string, min: string): boolean {
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}
