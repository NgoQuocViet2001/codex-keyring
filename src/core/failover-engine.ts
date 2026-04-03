import type { AccountRecord, AutoSwitchMode, FailoverReason } from "./types.js";

const BALANCED_THRESHOLDS = [50, 20, 5];

const PATTERN_TABLE: Array<{ reason: FailoverReason; patterns: RegExp[] }> = [
  {
    reason: "workspace-mismatch",
    patterns: [/workspace mismatch/i, /workspace policy/i, /rbac/i, /permission denied/i, /organization policy/i],
  },
  {
    reason: "auth-expired",
    patterns: [/invalid session/i, /expired token/i, /unauthorized/i, /\b401\b/u, /status_code":401/i, /login required/i],
  },
  {
    reason: "quota-exhausted",
    patterns: [
      /usage_limit_reached/i,
      /the usage limit has been reached/i,
      /usage limit has been reached/i,
      /usage cap/i,
      /quota exhausted/i,
      /credits exhausted/i,
      /"x-codex-primary-used-percent":"100"/i,
    ],
  },
  {
    reason: "rate-limited",
    patterns: [/rate limit/i, /too many requests/i, /\b429\b/u, /status_code":429/i, /retry later/i],
  },
];

interface AliasCandidate {
  alias: string;
  priority: number;
  remaining5h?: number;
  remainingWeek?: number;
  blocked: boolean;
  bucket: number;
}

function remaining5h(record: AccountRecord, now: number): number | undefined {
  const remaining = record.stats?.limit5hRemainingPercent;
  if (remaining === undefined) {
    return undefined;
  }

  const resetAt = record.stats?.limit5hResetAt ? Date.parse(record.stats.limit5hResetAt) : Number.NaN;
  if (!Number.isNaN(resetAt) && resetAt <= now) {
    return undefined;
  }

  return remaining;
}

function remainingWeek(record: AccountRecord, now: number): number | undefined {
  const remaining = record.stats?.limitWeekRemainingPercent;
  if (remaining === undefined) {
    return undefined;
  }

  const resetAt = record.stats?.limitWeekResetAt ? Date.parse(record.stats.limitWeekResetAt) : Number.NaN;
  if (!Number.isNaN(resetAt) && resetAt <= now) {
    return undefined;
  }

  return remaining;
}

function isCooldown(record: AccountRecord, now: number): boolean {
  const cooldownUntil = record.stats?.cooldownUntil ? Date.parse(record.stats.cooldownUntil) : Number.NaN;
  return !Number.isNaN(cooldownUntil) && cooldownUntil > now;
}

function isBlocked(record: AccountRecord, now: number): boolean {
  if (isCooldown(record, now)) {
    return true;
  }

  const quotaRemaining = remaining5h(record, now);
  return quotaRemaining !== undefined && quotaRemaining <= 0;
}

function toCandidate(record: AccountRecord, now: number): AliasCandidate {
  const currentRemaining5h = remaining5h(record, now);
  const currentRemainingWeek = remainingWeek(record, now);
  const blocked = isBlocked(record, now);

  let bucket = 2;
  if (blocked) {
    bucket = 0;
  } else if (currentRemaining5h !== undefined && currentRemaining5h > 0) {
    bucket = 3;
  } else if (currentRemaining5h === undefined) {
    bucket = 2;
  } else {
    bucket = 1;
  }

  return {
    alias: record.meta.alias,
    priority: record.meta.priority,
    remaining5h: currentRemaining5h,
    remainingWeek: currentRemainingWeek,
    blocked,
    bucket,
  };
}

function compareCandidates(left: AliasCandidate, right: AliasCandidate): number {
  return (
    right.bucket - left.bucket ||
    (right.remaining5h ?? -1) - (left.remaining5h ?? -1) ||
    (right.remainingWeek ?? -1) - (left.remainingWeek ?? -1) ||
    left.priority - right.priority ||
    left.alias.localeCompare(right.alias)
  );
}

function bestAvailableCandidate(currentAlias: string | undefined, records: AccountRecord[]): AliasCandidate | undefined {
  const now = Date.now();
  const candidates = records
    .filter((record) => record.meta.alias && record.meta.alias !== currentAlias)
    .map((record) => toCandidate(record, now))
    .sort(compareCandidates);

  return candidates.find((candidate) => candidate.bucket > 0);
}

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

export function pickNextAlias(
  currentAlias: string | undefined,
  records: AccountRecord[],
  options: {
    mode?: AutoSwitchMode;
    reason?: FailoverReason;
  } = {},
): string | undefined {
  const mode = options.mode ?? "balanced";
  const fallback = bestAvailableCandidate(currentAlias, records);

  if (!currentAlias || (options.reason && shouldAutoSwitch(options.reason))) {
    return fallback?.alias;
  }

  const currentRecord = records.find((record) => record.meta.alias === currentAlias);
  if (!currentRecord) {
    return fallback?.alias;
  }

  const now = Date.now();
  if (isBlocked(currentRecord, now)) {
    return fallback?.alias;
  }

  if (mode === "sequential") {
    return undefined;
  }

  const currentRemaining = remaining5h(currentRecord, now);
  if (currentRemaining === undefined) {
    return undefined;
  }

  const orderedCandidates = records
    .filter((record) => record.meta.alias && record.meta.alias !== currentAlias)
    .map((record) => toCandidate(record, now))
    .filter((candidate) => !candidate.blocked && candidate.remaining5h !== undefined)
    .sort(compareCandidates);

  for (const threshold of BALANCED_THRESHOLDS) {
    if (currentRemaining > threshold) {
      continue;
    }

    const preferred = orderedCandidates.find((candidate) => (candidate.remaining5h ?? 0) > threshold);
    if (preferred) {
      return preferred.alias;
    }
  }

  return undefined;
}
