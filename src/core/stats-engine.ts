import type { AccountStore } from "./account-store.js";
import { normalizeAuthMode } from "./auth-snapshot.js";
import type { AccountStats, ConfidenceLevel, HealthState, SwitchEvent } from "./types.js";

function rollingWindowHours(windowType: string): number {
  if (windowType.startsWith("manual:")) {
    return 24;
  }
  return 24;
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

function confidenceFromEvents(hasEvents: boolean, hasManualWindow: boolean): ConfidenceLevel {
  if (hasManualWindow) {
    return "manual";
  }
  if (hasEvents) {
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

export async function refreshStatsForAlias(store: AccountStore, alias: string): Promise<AccountStats> {
  const [meta, snapshot, state, events] = await Promise.all([
    store.getMeta(alias),
    store.getSnapshot(alias),
    store.getState(),
    store.listEvents(alias, 1_000),
  ]);
  const lifecycleEvents = scopeEventsToCurrentAliasLifecycle(events);

  const windowType = meta.manualWindow ? `manual:${meta.manualWindow.type}` : "rolling-24h";
  const hours = rollingWindowHours(windowType);
  const windowStart = Date.now() - hours * 60 * 60 * 1_000;
  const windowEvents = lifecycleEvents.filter((event) => Date.parse(event.timestamp) >= windowStart);
  const limitHits = windowEvents.filter((event) => event.type === "limit-hit");
  const requestEvents = windowEvents.filter((event) => event.type === "exec-success" || event.type === "exec-failure");
  const lastLimitHitAt = limitHits.at(-1)?.timestamp;
  const cooldownUntil =
    lastLimitHitAt && limitHits.length > 0 ? new Date(Date.parse(lastLimitHitAt) + 30 * 60 * 1_000).toISOString() : undefined;

  const stats: AccountStats = {
    alias,
    authMode: normalizeAuthMode(snapshot.auth.auth_mode),
    active: state.activeAlias === alias,
    health: deriveHealth(state.activeAlias === alias, lastLimitHitAt, cooldownUntil),
    confidence: confidenceFromEvents(lifecycleEvents.length > 0, Boolean(meta.manualWindow)),
    lastSuccessAt: collectLatest(lifecycleEvents, "exec-success") ?? meta.lastUsedAt,
    lastLimitHitAt,
    cooldownUntil,
    lastRefresh: snapshot.auth.last_refresh,
    estimatedRequestsThisWindow: requestEvents.length > 0 ? requestEvents.length : undefined,
    estimatedTokensThisWindow: meta.manualWindow?.tokensPerWindow,
    windowType,
    notes: meta.manualWindow
      ? "Quota window is manually annotated."
      : "Counts come from codex-accounts events; token estimates are not yet inferred from Codex internals.",
  };

  await store.saveStats(alias, stats);
  return stats;
}

export async function refreshAllStats(store: AccountStore): Promise<AccountStats[]> {
  const aliases = await store.listAliases();
  return Promise.all(aliases.map((alias) => refreshStatsForAlias(store, alias)));
}
