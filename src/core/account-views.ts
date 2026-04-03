import { extractAuthIdentity } from "./auth-snapshot.js";
import type { AccountStore } from "./account-store.js";
import { refreshAllStats, refreshStatsForAlias } from "./stats-engine.js";
import type { AuthMode, AutoSwitchMode, CodexKeyringState, ConfidenceLevel, HealthState } from "./types.js";

export interface PublicAccountView {
  alias: string;
  displayName: string;
  email?: string;
  organization?: string;
  planType?: string;
  active: boolean;
  authMode: AuthMode;
  priority: number;
  fingerprint: string;
  health: HealthState;
  confidence: ConfidenceLevel;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastSuccessAt?: string;
  lastLimitHitAt?: string;
  cooldownUntil?: string;
  lastRefresh?: string;
  quotaObservedAt?: string;
  quotaSource?: "codex-host-log" | "exec-output";
  limit5hUsedPercent?: number;
  limit5hRemainingPercent?: number;
  limit5hResetAt?: string;
  limitWeekUsedPercent?: number;
  limitWeekRemainingPercent?: number;
  limitWeekResetAt?: string;
  estimatedRequestsThisWindow?: number;
  estimatedTokensThisWindow?: number;
  windowType?: string;
  notes?: string;
}

export interface StatusAliasView {
  alias: string;
  email?: string;
  organization?: string;
  planType?: string;
  active: boolean;
  authMode: AuthMode;
  health: HealthState;
  confidence: ConfidenceLevel;
  limit5hRemainingPercent?: number;
  limitWeekRemainingPercent?: number;
  fingerprint: string;
}

export interface StatusView {
  state: CodexKeyringState & { autoSwitchMode: AutoSwitchMode };
  aliases: StatusAliasView[];
}

function normalizeOrganizationLabel(organization?: string, planType?: string): string | undefined {
  if (!organization) {
    return undefined;
  }

  const normalizedOrganization = organization.trim();
  if (!normalizedOrganization) {
    return undefined;
  }

  const normalizedPlan = planType?.trim().toLowerCase();
  if (
    normalizedOrganization.toLowerCase() === "personal" &&
    (normalizedPlan === "team" || normalizedPlan === "business" || normalizedPlan === "enterprise" || normalizedPlan === "education")
  ) {
    return undefined;
  }

  return normalizedOrganization;
}

function toPublicAccountView(record: {
  meta: {
    alias: string;
    displayName: string;
    email?: string;
    organization?: string;
    planType?: string;
    authMode: AuthMode;
    priority: number;
    fingerprint: string;
    createdAt: string;
    updatedAt: string;
    lastUsedAt?: string;
    notes?: string;
  };
  snapshot: {
    auth: Parameters<typeof extractAuthIdentity>[0];
  };
  stats?: {
    health?: HealthState;
    confidence?: ConfidenceLevel;
    lastSuccessAt?: string;
    lastLimitHitAt?: string;
    cooldownUntil?: string;
    lastRefresh?: string;
    quotaObservedAt?: string;
    quotaSource?: "codex-host-log" | "exec-output";
    limit5hUsedPercent?: number;
    limit5hRemainingPercent?: number;
    limit5hResetAt?: string;
    limitWeekUsedPercent?: number;
    limitWeekRemainingPercent?: number;
    limitWeekResetAt?: string;
    estimatedRequestsThisWindow?: number;
    estimatedTokensThisWindow?: number;
    windowType?: string;
    notes?: string;
  };
  active: boolean;
}): PublicAccountView {
  const identity = extractAuthIdentity(record.snapshot.auth);
  const planType = record.meta.planType ?? identity.planType;
  const organization = normalizeOrganizationLabel(record.meta.organization ?? identity.organization, planType);
  return {
    alias: record.meta.alias,
    displayName: record.meta.displayName,
    email: record.meta.email ?? identity.email,
    organization,
    planType,
    active: record.active,
    authMode: record.meta.authMode,
    priority: record.meta.priority,
    fingerprint: record.meta.fingerprint,
    health: record.stats?.health ?? "unknown",
    confidence: record.stats?.confidence ?? "estimated",
    createdAt: record.meta.createdAt,
    updatedAt: record.meta.updatedAt,
    lastUsedAt: record.meta.lastUsedAt,
    lastSuccessAt: record.stats?.lastSuccessAt,
    lastLimitHitAt: record.stats?.lastLimitHitAt,
    cooldownUntil: record.stats?.cooldownUntil,
    lastRefresh: record.stats?.lastRefresh,
    quotaObservedAt: record.stats?.quotaObservedAt,
    quotaSource: record.stats?.quotaSource,
    limit5hUsedPercent: record.stats?.limit5hUsedPercent,
    limit5hRemainingPercent: record.stats?.limit5hRemainingPercent,
    limit5hResetAt: record.stats?.limit5hResetAt,
    limitWeekUsedPercent: record.stats?.limitWeekUsedPercent,
    limitWeekRemainingPercent: record.stats?.limitWeekRemainingPercent,
    limitWeekResetAt: record.stats?.limitWeekResetAt,
    estimatedRequestsThisWindow: record.stats?.estimatedRequestsThisWindow,
    estimatedTokensThisWindow: record.stats?.estimatedTokensThisWindow,
    windowType: record.stats?.windowType,
    notes: record.stats?.notes ?? record.meta.notes,
  };
}

export async function listAccountsWithFreshStats(store: AccountStore): Promise<PublicAccountView[]> {
  await refreshAllStats(store);
  const records = await store.listAccounts();
  return records.map((record) => toPublicAccountView(record));
}

export async function getStatusView(store: AccountStore): Promise<StatusView> {
  const accounts = await listAccountsWithFreshStats(store);
  return {
    state: await store.getState(),
    aliases: accounts.map((account) => ({
      alias: account.alias,
      email: account.email,
      organization: account.organization,
      planType: account.planType,
      active: account.active,
      authMode: account.authMode,
      health: account.health,
      confidence: account.confidence,
      limit5hRemainingPercent: account.limit5hRemainingPercent,
      limitWeekRemainingPercent: account.limitWeekRemainingPercent,
      fingerprint: account.fingerprint,
    })),
  };
}

export async function getAccountInfoView(store: AccountStore, alias: string): Promise<PublicAccountView> {
  await refreshStatsForAlias(store, alias);
  const [state, meta, snapshot, stats] = await Promise.all([
    store.getState(),
    store.getMeta(alias),
    store.getSnapshot(alias),
    store.getStats(alias),
  ]);

  return toPublicAccountView({
    meta,
    snapshot,
    stats,
    active: state.activeAlias === alias,
  });
}
