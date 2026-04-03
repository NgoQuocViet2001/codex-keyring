import type { AccountRecord, FailoverReason } from "./types.js";

const PATTERN_TABLE: Array<{ reason: FailoverReason; patterns: RegExp[] }> = [
  {
    reason: "workspace-mismatch",
    patterns: [
      /workspace mismatch/i,
      /workspace policy/i,
      /rbac/i,
      /permission denied/i,
      /organization policy/i,
      /forbidden/i,
      /\b403\b/u,
      /status_code":403/i,
    ],
  },
  {
    reason: "auth-expired",
    patterns: [/invalid session/i, /expired token/i, /unauthorized/i, /\b401\b/u, /status_code":401/i, /login required/i],
  },
  {
    reason: "quota-exhausted",
    patterns: [/quota/i, /credits exhausted/i, /limit reached/i, /usage cap/i, /usage limit/i, /usage_limit_reached/i],
  },
  {
    reason: "rate-limited",
    patterns: [/rate limit/i, /too many requests/i, /\b429\b/u, /status_code":429/i, /retry later/i],
  },
];

export function classifyFailure(output: string): FailoverReason | undefined {
  const text = output.toLowerCase();
  for (const entry of PATTERN_TABLE) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      return entry.reason;
    }
  }
  return undefined;
}

export function shouldAutoSwitch(reason?: FailoverReason): boolean {
  return reason === "quota-exhausted" || reason === "rate-limited" || reason === "auth-expired" || reason === "workspace-mismatch";
}

export function pickNextAlias(currentAlias: string | undefined, records: AccountRecord[]): string | undefined {
  const now = Date.now();
  const ordered = [...records].sort(
    (left, right) => left.meta.priority - right.meta.priority || left.meta.alias.localeCompare(right.meta.alias),
  );

  if (ordered.length === 0) {
    return undefined;
  }

  const currentIndex = ordered.findIndex((record) => record.meta.alias === currentAlias);
  const rotated = currentIndex >= 0 ? [...ordered.slice(currentIndex + 1), ...ordered.slice(0, currentIndex + 1)] : ordered;

  return rotated.find((record) => {
    if (!record.meta.alias || record.meta.alias === currentAlias) {
      return false;
    }

    const cooldownUntil = record.stats?.cooldownUntil ? Date.parse(record.stats.cooldownUntil) : Number.NaN;
    if (!Number.isNaN(cooldownUntil) && cooldownUntil > now) {
      return false;
    }

    return true;
  })?.meta.alias;
}
