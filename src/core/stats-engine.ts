import { pathExists } from "../platform/codex-home.js";
import type { AccountStore } from "./account-store.js";
import { normalizeAuthMode } from "./auth-snapshot.js";
import { extractQuotaSnapshotFromText } from "./quota-snapshot.js";
import { pickQuotaWindow } from "./quota-snapshot.js";
import type { AccountStats, ConfidenceLevel, HealthState, QuotaSnapshot, SwitchEvent } from "./types.js";

type SqliteModule = typeof import("node:sqlite");

function rollingWindowHours(windowType: string): number {
  if (windowType.startsWith("manual:")) {
    return 24;
  }
  return 24;
}

function quotaSnapshotFromEvent(event: SwitchEvent): QuotaSnapshot | undefined {
  const quotaSnapshot = event.details?.quotaSnapshot;
  if (!quotaSnapshot || typeof quotaSnapshot !== "object" || Array.isArray(quotaSnapshot)) {
    return undefined;
  }

  return quotaSnapshot as QuotaSnapshot;
}

function deriveHealth(active: boolean, lastLimitHitAt?: string, cooldownUntil?: string): HealthState {
  const now = Date.now();
  if (cooldownUntil && Date.parse(cooldownUntil) > now) {
    return "cooldown";
  }
  if (active) {
    return "active";
  }
  if (lastLimitHitAt) {
    return "degraded";
  }
  return "ready";
}

function confidenceFromEvents(hasExactQuota: boolean, hasEvents: boolean, hasManualWindow: boolean): ConfidenceLevel {
  if (hasManualWindow) {
    return "manual";
  }
  if (hasExactQuota || hasEvents) {
    return "exact";
  }
  return "estimated";
}

function collectLatest(events: SwitchEvent[], type: SwitchEvent["type"]): string | undefined {
  return [...events].reverse().find((event) => event.type === type)?.timestamp;
}

function scopeEventsToCurrentAliasLifecycle(events: SwitchEvent[]): SwitchEvent[] {
  const lastAddAccountIndex = [...events].reverse().findIndex((event) => event.type === "add-account");
  if (lastAddAccountIndex < 0) {
    return events;
  }

  const startIndex = events.length - 1 - lastAddAccountIndex;
  return events.slice(startIndex);
}

function latestQuotaSnapshot(events: SwitchEvent[]): QuotaSnapshot | undefined {
  return [...events].reverse().map((event) => quotaSnapshotFromEvent(event)).find((snapshot) => Boolean(snapshot));
}

function isQuotaCooldownEvent(event: SwitchEvent): boolean {
  return event.type === "limit-hit" && (event.reason === "quota-exhausted" || event.reason === "rate-limited");
}

async function importSqliteModule(): Promise<SqliteModule | undefined> {
  try {
    return (await import("node:sqlite")) as SqliteModule;
  } catch {
    return undefined;
  }
}

async function readQuotaSnapshotFromHostLogIds(store: AccountStore, events: SwitchEvent[]): Promise<QuotaSnapshot | undefined> {
  const hostLogIds = [...new Set(
    [...events]
      .reverse()
      .map((event) => event.details?.hostLogId)
      .filter((value): value is number => typeof value === "number"),
  )].slice(0, 25);

  if (hostLogIds.length === 0 || !(await pathExists(store.env.codexLogsDbPath))) {
    return undefined;
  }

  const sqlite = await importSqliteModule();
  if (!sqlite) {
    return undefined;
  }

  let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;

  try {
    db = new sqlite.DatabaseSync(store.env.codexLogsDbPath, { readOnly: true });
    const statement = db.prepare("SELECT ts, feedback_log_body FROM logs WHERE id = ?");

    for (const hostLogId of hostLogIds) {
      const row = statement.get(hostLogId) as { ts?: number; feedback_log_body?: string | null } | undefined;
      if (!row?.feedback_log_body) {
        continue;
      }

      const capturedAt = typeof row.ts === "number" ? new Date(row.ts * 1_000).toISOString() : new Date().toISOString();
      const snapshot = extractQuotaSnapshotFromText(row.feedback_log_body, capturedAt);
      if (snapshot) {
        return snapshot;
      }
    }
  } catch {
    return undefined;
  } finally {
    db?.close();
  }

  return undefined;
}

function deriveCooldownUntil(lastQuotaCooldownAt: string | undefined, limit5hResetAt?: string): string | undefined {
  if (limit5hResetAt && Date.parse(limit5hResetAt) > Date.now()) {
    return limit5hResetAt;
  }

  return lastQuotaCooldownAt ? new Date(Date.parse(lastQuotaCooldownAt) + 30 * 60 * 1_000).toISOString() : undefined;
}

export async function refreshStatsForAlias(store: AccountStore, alias: string): Promise<AccountStats> {
  const [meta, snapshot, state, events] = await Promise.all([
    store.getMeta(alias),
    store.getSnapshot(alias),
    store.getState(),
    store.listEvents(alias, 1_000),
  ]);
  const lifecycleEvents = scopeEventsToCurrentAliasLifecycle(events);

  const quotaSnapshot = latestQuotaSnapshot(lifecycleEvents) ?? (await readQuotaSnapshotFromHostLogIds(store, lifecycleEvents));
  const limit5h = pickQuotaWindow(quotaSnapshot, 300);
  const limitWeek = pickQuotaWindow(quotaSnapshot, 10_080);

  const windowType = quotaSnapshot ? "codex-rate-limits" : meta.manualWindow ? `manual:${meta.manualWindow.type}` : "rolling-24h";
  const hours = rollingWindowHours(windowType);
  const windowStart = Date.now() - hours * 60 * 60 * 1_000;
  const windowEvents = lifecycleEvents.filter((event) => Date.parse(event.timestamp) >= windowStart);
  const limitHits = windowEvents.filter((event) => event.type === "limit-hit");
  const quotaCooldownEvents = windowEvents.filter((event) => isQuotaCooldownEvent(event));
  const requestEvents = windowEvents.filter((event) => event.type === "exec-success" || event.type === "exec-failure");
  const lastLimitHitAt = limitHits.at(-1)?.timestamp;
  const lastQuotaCooldownAt = quotaCooldownEvents.at(-1)?.timestamp;
  const cooldownUntil = deriveCooldownUntil(lastQuotaCooldownAt, limit5h?.remainingPercent === 0 ? limit5h.resetAt : undefined);

  const stats: AccountStats = {
    alias,
    authMode: normalizeAuthMode(snapshot.auth.auth_mode),
    active: state.activeAlias === alias,
    health: deriveHealth(state.activeAlias === alias, lastLimitHitAt, cooldownUntil),
    confidence: confidenceFromEvents(Boolean(quotaSnapshot), lifecycleEvents.length > 0, Boolean(meta.manualWindow)),
    lastSuccessAt: collectLatest(lifecycleEvents, "exec-success") ?? meta.lastUsedAt,
    lastLimitHitAt,
    cooldownUntil,
    lastRefresh: snapshot.auth.last_refresh,
    quotaObservedAt: quotaSnapshot?.capturedAt,
    quotaSource: quotaSnapshot?.source,
    limit5hUsedPercent: limit5h?.usedPercent,
    limit5hRemainingPercent: limit5h?.remainingPercent,
    limit5hResetAt: limit5h?.resetAt,
    limitWeekUsedPercent: limitWeek?.usedPercent,
    limitWeekRemainingPercent: limitWeek?.remainingPercent,
    limitWeekResetAt: limitWeek?.resetAt,
    estimatedRequestsThisWindow: requestEvents.length > 0 ? requestEvents.length : undefined,
    estimatedTokensThisWindow: meta.manualWindow?.tokensPerWindow,
    windowType,
    notes: meta.manualWindow
      ? "Quota window is manually annotated."
      : quotaSnapshot
        ? "Quota data comes from Codex host rate-limit signals."
        : "Exact Codex quota data has not been observed locally yet.",
  };

  await store.saveStats(alias, stats);
  return stats;
}

export async function refreshAllStats(store: AccountStore): Promise<AccountStats[]> {
  const aliases = await store.listAliases();
  return Promise.all(aliases.map((alias) => refreshStatsForAlias(store, alias)));
}
