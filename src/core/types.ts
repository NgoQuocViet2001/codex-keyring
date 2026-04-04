export type AuthMode = "chatgpt" | "api_key" | "unknown";
export type ConfidenceLevel = "exact" | "estimated" | "manual";
export type HealthState = "active" | "ready" | "cooldown" | "degraded" | "unknown";
export type AutoSwitchMode = "off" | "balanced" | "sequential";
export type FailoverReason =
  | "quota-exhausted"
  | "rate-limited"
  | "auth-expired"
  | "workspace-mismatch"
  | "quota-rebalance"
  | "manual"
  | "unknown";

export interface CodexTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
}

export interface CodexAuthFile {
  auth_mode?: string;
  last_refresh?: string;
  OPENAI_API_KEY?: string;
  tokens?: CodexTokens;
}

export interface AccountSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  source: "active-auth" | "login-flow";
  auth: CodexAuthFile;
}

export interface ManualWindowConfig {
  type: string;
  requestsPerWindow?: number;
  tokensPerWindow?: number;
  resetHint?: string;
}

export interface QuotaWindowSnapshot {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetAfterSeconds?: number;
  resetAt?: string;
}

export interface QuotaSnapshot {
  capturedAt: string;
  source: "codex-host-log" | "codex-session-log" | "exec-output";
  activeLimit?: string;
  planType?: string;
  primary?: QuotaWindowSnapshot;
  secondary?: QuotaWindowSnapshot;
}

export interface AccountMeta {
  alias: string;
  displayName: string;
  priority: number;
  manualOnly: boolean;
  notes?: string;
  email?: string;
  organization?: string;
  planType?: string;
  fingerprint: string;
  authMode: AuthMode;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  manualWindow?: ManualWindowConfig;
}

export interface CodexKeyringState {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  activeAlias?: string;
  autoSwitch: boolean;
  autoSwitchMode: AutoSwitchMode;
  managedAuthMode: boolean;
  lastSwitchAt?: string;
  originalCliAuthCredentialsStore?: string;
}

export interface HostLogState {
  lastProcessedId?: number;
  updatedAt: string;
}

export interface SwitchEvent {
  id: string;
  timestamp: string;
  type:
    | "install"
    | "uninstall"
    | "add-account"
    | "remove-account"
    | "rename-account"
    | "switch"
    | "limit-hit"
    | "quota-observed"
    | "exec-success"
    | "exec-failure"
    | "doctor";
  alias?: string;
  reason?: FailoverReason | string;
  details?: Record<string, unknown>;
}

export interface AccountStats {
  alias: string;
  authMode: AuthMode;
  active: boolean;
  health: HealthState;
  confidence: ConfidenceLevel;
  lastSuccessAt?: string;
  lastLimitHitAt?: string;
  cooldownUntil?: string;
  lastRefresh?: string;
  quotaObservedAt?: string;
  quotaSource?: QuotaSnapshot["source"];
  limit5hUsedPercent?: number;
  limit5hRemainingPercent?: number;
  limit5hResetAt?: string;
  limitWeekUsedPercent?: number;
  limitWeekRemainingPercent?: number;
  limitWeekResetAt?: string;
  estimatedRequestsThisWindow?: number;
  estimatedTokensThisWindow?: number;
  windowType: string;
  notes?: string;
}

export interface AccountRecord {
  meta: AccountMeta;
  snapshot: AccountSnapshot;
  stats?: AccountStats;
  active: boolean;
}

export interface DoctorCheck {
  key: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  details?: string;
}

export interface DoctorResult {
  generatedAt: string;
  checks: DoctorCheck[];
}

export interface InstallResult {
  pluginPath: string;
  marketplacePath: string;
  managedAuthChanged: boolean;
}
