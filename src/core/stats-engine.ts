import { extractAuthIdentity } from "./auth-snapshot.js";
import { pathExists } from "../platform/codex-home.js";
import type { AccountStore } from "./account-store.js";
import { findLatestSessionQuotaObservation } from "./codex-session-log.js";
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

function normalizeEmail(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function collectIdentityEmails(meta: { email?: string }, snapshot: { auth: Parameters<typeof extractAuthIdentity>[0] }): string[] {
  return [...new Set([
    normalizeEmail(meta.email),
    normalizeEmail(extractAuthIdentity(snapshot.auth).email),
  ].filter((value): value is string => Boolean(value)))];
}

function eventIdentityEmail(event: SwitchEvent): string | undefined {
  const email = event.details?.email;
  return typeof email === "string" ? normalizeEmail(email) : undefined;
}

function mergeRelatedEvents(lineageEvents: SwitchEvent[], allEvents: SwitchEvent[], identityEmails: string[]): SwitchEvent[] {
  if (identityEmails.length === 0) {
    return lineageEvents;
  }

  const lineageIds = new Set(lineageEvents.map((event) => event.id));
  return allEvents
    .filter((event) => lineageIds.has(event.id) || identityEmails.includes(eventIdentityEmail(event) ?? ""))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function normalizeQuotaWindow(window: QuotaSnapshot["primary"], now: number) {
  if (!window) {
    return undefined;
  }

  const resetAtMs = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
  if (!Number.isNaN(resetAtMs) && resetAtMs <= now) {
    return undefined;
  }

  return window;
}

function normalizeQuotaSnapshot(snapshot: QuotaSnapshot | undefined, now = Date.now()): QuotaSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }

  const primary = normalizeQuotaWindow(snapshot.primary, now);
  const secondary = normalizeQuotaWindow(snapshot.secondary, now);
  if (!primary && !secondary) {
    return undefined;
  }

  return {
    ...snapshot,
    primary,
    secondary,
  };
}

function pickFreshestQuotaSnapshot(...snapshots: Array<QuotaSnapshot | undefined>): QuotaSnapshot | undefined {
  return snapshots
    .filter((snapshot): snapshot is QuotaSnapshot => Boolean(snapshot))
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0];
}

function deriveHealth(
  active: boolean,
  lastLimitHitAt: string | undefined,
  cooldownUntil: string | undefined,
  quotaRecovered: boolean,
): HealthState {
  const now = Date.now();
  if (cooldownUntil && Date.parse(cooldownUntil) > now) {
    return "cooldown";
  }
  if (quotaRecovered) {
    return active ? "active" : "ready";
  }
  if (lastLimitHitAt) {
    return "degraded";
  }
  if (active) {
    return "active";
  }
  return "ready";
}

function quotaRecoveredAfterLimitHit(
  quotaSnapshot: QuotaSnapshot | undefined,
  lastLimitHitAt: string | undefined,
  limit5hRemainingPercent: number | undefined,
  limitWeekRemainingPercent: number | undefined,
): boolean {
  const hasRemainingQuota =
    (limit5hRemainingPercent === undefined || limit5hRemainingPercent > 0) &&
    (limitWeekRemainingPercent === undefined || limitWeekRemainingPercent > 0);

  if (!hasRemainingQuota) {
    return false;
  }

  if (!lastLimitHitAt) {
    return true;
  }

  if (!quotaSnapshot?.capturedAt) {
    return false;
  }

  return Date.parse(quotaSnapshot.capturedAt) >= Date.parse(lastLimitHitAt);
}

function summarizeQuotaNote(meta: { manualWindow?: unknown }, quotaSnapshot: QuotaSnapshot | undefined, quotaRecovered: boolean): string {
  if (meta.manualWindow) {
    return "Quota window is manually annotated.";
  }
  if (quotaSnapshot) {
    const sourceLabel =
      quotaSnapshot.source === "codex-session-log"
        ? "live Codex session rate-limit signals"
        : quotaSnapshot.source === "exec-output"
          ? "live command output rate-limit signals"
          : "recent Codex host rate-limit signals";
    return quotaRecovered
      ? `Quota data comes from ${sourceLabel} and reflects recovered headroom.`
      : `Quota data comes from ${sourceLabel}.`;
  }
  return "Exact Codex quota data has not been observed locally yet.";
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

async function readQuotaSnapshotFromActiveSession(
  store: AccountStore,
  alias: string,
  activeAlias: string | undefined,
  lastSwitchAt: string | undefined,
): Promise<QuotaSnapshot | undefined> {
  if (activeAlias !== alias) {
    return undefined;
  }

  const observation = await findLatestSessionQuotaObservation(
    store.env.codexHome,
    lastSwitchAt ? { since: lastSwitchAt } : {},
  );
  return observation?.quotaSnapshot;
}

function deriveCooldownUntil(lastQuotaCooldownAt: string | undefined, limit5hResetAt?: string): string | undefined {
  if (limit5hResetAt && Date.parse(limit5hResetAt) > Date.now()) {
    return limit5hResetAt;
  }

  return lastQuotaCooldownAt ? new Date(Date.parse(lastQuotaCooldownAt) + 30 * 60 * 1_000).toISOString() : undefined;
}

export async function refreshStatsForAlias(store: AccountStore, alias: string): Promise<AccountStats> {
  const [meta, snapshot, state, lineageEvents, allEvents] = await Promise.all([
    store.getMeta(alias),
    store.getSnapshot(alias),
    store.getState(),
    store.listEvents(alias, 5_000),
    store.listEvents(undefined, 5_000),
  ]);
  const lifecycleEvents = scopeEventsToCurrentAliasLifecycle(lineageEvents);
  const relatedEvents = mergeRelatedEvents(lifecycleEvents, allEvents, collectIdentityEmails(meta, snapshot));

  const quotaSnapshot = normalizeQuotaSnapshot(
    pickFreshestQuotaSnapshot(
      normalizeQuotaSnapshot(latestQuotaSnapshot(relatedEvents)),
      normalizeQuotaSnapshot(await readQuotaSnapshotFromHostLogIds(store, relatedEvents)),
      normalizeQuotaSnapshot(await readQuotaSnapshotFromActiveSession(store, alias, state.activeAlias, state.lastSwitchAt)),
    ),
  );
  const limit5h = pickQuotaWindow(quotaSnapshot, 300);
  const limitWeek = pickQuotaWindow(quotaSnapshot, 10_080);

  const windowType = quotaSnapshot ? "codex-rate-limits" : meta.manualWindow ? `manual:${meta.manualWindow.type}` : "rolling-24h";
  const hours = rollingWindowHours(windowType);
  const windowStart = Date.now() - hours * 60 * 60 * 1_000;
  const windowEvents = relatedEvents.filter((event) => Date.parse(event.timestamp) >= windowStart);
  const limitHits = windowEvents.filter((event) => event.type === "limit-hit");
  const quotaCooldownEvents = windowEvents.filter((event) => isQuotaCooldownEvent(event));
  const requestEvents = windowEvents.filter((event) => event.type === "exec-success" || event.type === "exec-failure");
  const lastLimitHitAt = limitHits.at(-1)?.timestamp;
  const lastQuotaCooldownAt = quotaCooldownEvents.at(-1)?.timestamp;
  const cooldownUntil = deriveCooldownUntil(lastQuotaCooldownAt, limit5h?.remainingPercent === 0 ? limit5h.resetAt : undefined);
  const quotaRecovered = quotaRecoveredAfterLimitHit(
    quotaSnapshot,
    lastLimitHitAt,
    limit5h?.remainingPercent,
    limitWeek?.remainingPercent,
  );

  const stats: AccountStats = {
    alias,
    authMode: normalizeAuthMode(snapshot.auth.auth_mode),
    active: state.activeAlias === alias,
    health: deriveHealth(state.activeAlias === alias, lastLimitHitAt, cooldownUntil, quotaRecovered),
    confidence: confidenceFromEvents(Boolean(quotaSnapshot), relatedEvents.length > 0, Boolean(meta.manualWindow)),
    lastSuccessAt: collectLatest(relatedEvents, "exec-success") ?? meta.lastUsedAt,
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
    notes: quotaSnapshot
      ? summarizeQuotaNote(meta, quotaSnapshot, quotaRecovered)
      : "Exact Codex quota data has not been observed locally yet.",
  };

  await store.saveStats(alias, stats);
  return stats;
}

export async function refreshAllStats(store: AccountStore): Promise<AccountStats[]> {
  const aliases = await store.listAliases();
  return Promise.all(aliases.map((alias) => refreshStatsForAlias(store, alias)));
}
