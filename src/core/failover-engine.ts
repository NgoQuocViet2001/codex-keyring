import type { AccountRecord, AutoSwitchMode, FailoverReason } from "./types.js";

const BALANCED_SCORE_5H_WEIGHT = 0.7;
const BALANCED_SCORE_WEEK_WEIGHT = 0.3;
const BALANCED_5H_REBALANCE_THRESHOLD = 20;
const BALANCED_WEEK_REBALANCE_THRESHOLD = 15;
const BALANCED_WEEK_REBALANCE_MARGIN = 10;

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
    patterns: [
      /usage_limit_reached/i,
      /the usage limit has been reached/i,
      /usage limit has been reached/i,
      /usage cap/i,
      /quota exhausted/i,
      /credits exhausted/i,
      /"x-codex-primary-used-percent":"100"/i,
      /insufficient quota/i,
      /insufficient_quota/i,
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
  manualOnly: boolean;
  bucket: number;
  level: number;
  score: number;
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

  const quotaRemaining5h = remaining5h(record, now);
  if (quotaRemaining5h !== undefined && quotaRemaining5h <= 0) {
    return true;
  }

  const quotaRemainingWeek = remainingWeek(record, now);
  return quotaRemainingWeek !== undefined && quotaRemainingWeek <= 0;
}

function quotaLevel(remaining?: number): number | undefined {
  if (remaining === undefined) {
    return undefined;
  }
  if (remaining <= 0) {
    return 0;
  }
  if (remaining <= 5) {
    return 1;
  }
  if (remaining <= 20) {
    return 2;
  }
  if (remaining <= 50) {
    return 3;
  }
  return 4;
}

function candidateLevel(remaining5hValue?: number, remainingWeekValue?: number, blocked = false): number {
  if (blocked) {
    return 0;
  }

  const levels = [quotaLevel(remaining5hValue), quotaLevel(remainingWeekValue)].filter((value): value is number => value !== undefined);
  if (levels.length === 0) {
    return 3;
  }

  return Math.min(...levels);
}

function candidateScore(remaining5hValue?: number, remainingWeekValue?: number): number {
  if (remaining5hValue !== undefined && remainingWeekValue !== undefined) {
    return remaining5hValue * BALANCED_SCORE_5H_WEIGHT + remainingWeekValue * BALANCED_SCORE_WEEK_WEIGHT;
  }
  if (remaining5hValue !== undefined) {
    return remaining5hValue;
  }
  if (remainingWeekValue !== undefined) {
    return remainingWeekValue;
  }
  return -1;
}

function toCandidate(record: AccountRecord, now: number): AliasCandidate {
  const currentRemaining5h = remaining5h(record, now);
  const currentRemainingWeek = remainingWeek(record, now);
  const blocked = isBlocked(record, now);
  const manualOnly = Boolean(record.meta.manualOnly);
  const level = candidateLevel(currentRemaining5h, currentRemainingWeek, blocked);

  return {
    alias: record.meta.alias,
    priority: record.meta.priority,
    remaining5h: currentRemaining5h,
    remainingWeek: currentRemainingWeek,
    blocked,
    manualOnly,
    bucket: manualOnly ? 0 : level > 0 ? 3 : 0,
    level,
    score: candidateScore(currentRemaining5h, currentRemainingWeek),
  };
}

function compareCandidates(left: AliasCandidate, right: AliasCandidate): number {
  return (
    right.bucket - left.bucket ||
    right.level - left.level ||
    right.score - left.score ||
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
    .filter((candidate) => !candidate.manualOnly)
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
    allowRebalance?: boolean;
  } = {},
): string | undefined {
  const mode = options.mode ?? "balanced";
  if (mode === "off") {
    return undefined;
  }

  const fallback = bestAvailableCandidate(currentAlias, records);
  if (!currentAlias) {
    return fallback?.alias;
  }

  const currentRecord = records.find((record) => record.meta.alias === currentAlias);
  if (!currentRecord) {
    return fallback?.alias;
  }

  const now = Date.now();
  const currentCandidate = toCandidate(currentRecord, now);
  if (currentCandidate.manualOnly) {
    return undefined;
  }

  if (options.reason && shouldAutoSwitch(options.reason)) {
    return fallback?.alias;
  }

  if (currentCandidate.blocked) {
    return fallback?.alias;
  }

  if (mode === "sequential" || options.allowRebalance === false) {
    return undefined;
  }

  const orderedCandidates = records
    .filter((record) => record.meta.alias && record.meta.alias !== currentAlias)
    .map((record) => toCandidate(record, now))
    .filter((candidate) => !candidate.manualOnly && !candidate.blocked)
    .sort(compareCandidates);
  const preferred = orderedCandidates[0];
  if (!preferred || preferred.level <= currentCandidate.level) {
    return undefined;
  }

  const shouldRebalanceFor5h =
    currentCandidate.remaining5h !== undefined &&
    currentCandidate.remaining5h <= BALANCED_5H_REBALANCE_THRESHOLD &&
    (preferred.remaining5h ?? -1) > BALANCED_5H_REBALANCE_THRESHOLD &&
    (preferred.remaining5h ?? -1) > currentCandidate.remaining5h;

  const shouldRebalanceForWeek =
    currentCandidate.remainingWeek !== undefined &&
    currentCandidate.remainingWeek <= BALANCED_WEEK_REBALANCE_THRESHOLD &&
    preferred.remainingWeek !== undefined &&
    preferred.remainingWeek >= currentCandidate.remainingWeek + BALANCED_WEEK_REBALANCE_MARGIN;

  if (shouldRebalanceFor5h || shouldRebalanceForWeek) {
    return preferred.alias;
  }

  return undefined;
}
