import { randomUUID } from "node:crypto";
import { pathExists } from "../platform/codex-home.js";
import type { AccountStore } from "./account-store.js";
import { extractAuthIdentity } from "./auth-snapshot.js";
import { classifyFailure, pickNextAlias, shouldAutoSwitch } from "./failover-engine.js";
import { extractQuotaSnapshotFromText } from "./quota-snapshot.js";
import { refreshAllStats } from "./stats-engine.js";
import { switchActiveAlias } from "./switch-engine.js";
import type { AccountRecord, FailoverReason } from "./types.js";

const BOOTSTRAP_LOOKBACK_ROWS = 5_000;
const HISTORICAL_BACKFILL_LOOKBACK_ROWS = 1_000_000;
const OVERLAP_LOOKBACK_ROWS = 25_000;
const MAX_QUERY_ROWS = 20_000;
const MAX_CONTEXT_ID_DISTANCE = 500;
const MAX_CONTEXT_AGE_SECONDS = 120;

type SqliteModule = typeof import("node:sqlite");

interface RawHostLogRow {
  id: number;
  ts: number;
  thread_id?: string | null;
  process_uuid?: string | null;
  feedback_log_body?: string | null;
}

export interface HostLogRow {
  id: number;
  ts: number;
  threadId?: string;
  processUuid?: string;
  body: string;
}

interface HostLogReadResult {
  available: boolean;
  latestId?: number;
  rows: HostLogRow[];
  reason?: string;
}

interface ParsedHostLogRow extends HostLogRow {
  directEmail?: string;
  contextEmail?: string;
  reason?: FailoverReason;
  quotaSnapshot?: ReturnType<typeof extractQuotaSnapshotFromText>;
  resolvedAlias?: string;
}

interface HostFailureCandidate {
  alias: string;
  reason: FailoverReason;
  row: HostLogRow;
  email?: string;
  quotaSnapshot?: ReturnType<typeof extractQuotaSnapshotFromText>;
}

interface HostQuotaObservation {
  alias: string;
  row: HostLogRow;
  email?: string;
  quotaSnapshot: NonNullable<ReturnType<typeof extractQuotaSnapshotFromText>>;
}

export interface HostReconciliationResult {
  available: boolean;
  rowsScanned: number;
  appendedEvents: number;
  switchedTo?: string;
  reason?: string;
}

interface ReconciliationOptions {
  rows?: HostLogRow[];
  allowSwitch?: boolean;
}

async function maybeSwitchBlockedAlias(
  store: AccountStore,
  state: Awaited<ReturnType<AccountStore["getState"]>>,
  allowSwitch: boolean,
  reason?: FailoverReason,
): Promise<string | undefined> {
  if (!allowSwitch || !state.autoSwitch || !state.activeAlias) {
    return undefined;
  }

  const refreshedRecords = await store.listAccounts();
  const nextAlias = pickNextAlias(state.activeAlias, refreshedRecords, {
    mode: state.autoSwitchMode,
    reason,
    allowRebalance: reason !== undefined,
  });
  if (!nextAlias) {
    return undefined;
  }

  await switchActiveAlias(store, nextAlias, reason ?? "quota-rebalance");
  await refreshAllStats(store);
  return nextAlias;
}

function normalizeEmail(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function extractEmailFromHostLog(body: string): string | undefined {
  const patterns = [
    /user\.email="([^"]+)"/iu,
    /user\.email=([^\s]+@[^\s]+)/iu,
    /"email"\s*:\s*"([^"]+@[^"]+)"/iu,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(body);
    const email = normalizeEmail(match?.[1]);
    if (email) {
      return email;
    }
  }

  return undefined;
}

function isHostNoise(body: string): boolean {
  const noisePatterns = [
    /response\.function_call_arguments/i,
    /response\.output_item\.done/i,
    /response\.completed/i,
    /toolcall:\s*shell_command/i,
    /event\.name="codex\.tool_result"/i,
    /handle_tool_call/i,
  ];

  return noisePatterns.some((pattern) => pattern.test(body));
}

function isHostSignalRow(body: string): boolean {
  if (isHostNoise(body)) {
    return false;
  }

  const signalPatterns = [
    /user\.email=/i,
    /user\.email"/i,
    /event\.kind=codex\.rate_limits/i,
    /"type":"codex\.rate_limits"/i,
    /received message \{"type":"error"/i,
    /websocket event: \{"type":"error"/i,
    /status_code":429/i,
    /status_code":401/i,
    /usage_limit_reached/i,
    /workspace mismatch/i,
    /workspace policy/i,
    /rbac/i,
    /permission denied/i,
    /organization policy/i,
    /expired token/i,
    /unauthorized/i,
  ];

  return signalPatterns.some((pattern) => pattern.test(body));
}

function toHostLogRow(row: RawHostLogRow): HostLogRow {
  return {
    id: row.id,
    ts: row.ts,
    threadId: row.thread_id ?? undefined,
    processUuid: row.process_uuid ?? undefined,
    body: row.feedback_log_body ?? "",
  };
}

async function importSqliteModule(): Promise<SqliteModule | undefined> {
  try {
    return (await import("node:sqlite")) as SqliteModule;
  } catch {
    return undefined;
  }
}

async function readHostLogRowsFromSqlite(store: AccountStore): Promise<HostLogReadResult> {
  if (!(await pathExists(store.env.codexLogsDbPath))) {
    return {
      available: false,
      reason: "codex-host-log-missing",
      rows: [],
    };
  }

  const sqlite = await importSqliteModule();
  if (!sqlite) {
    return {
      available: false,
      reason: "native-sqlite-unavailable",
      rows: [],
    };
  }

  const hostState = await store.getHostLogState();
  let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;

  try {
    db = new sqlite.DatabaseSync(store.env.codexLogsDbPath, { readOnly: true });
    const latestRow = db.prepare("SELECT id FROM logs ORDER BY id DESC LIMIT 1").get() as { id?: number } | undefined;
    const latestId = typeof latestRow?.id === "number" ? latestRow.id : undefined;
    if (latestId === undefined) {
      return { available: true, latestId, rows: [] };
    }

    const records = await store.listAccounts();
    const needsHistoricalBackfill = records.some((record) => record.stats?.limit5hRemainingPercent === undefined);
    const lookbackRows = hostState.lastProcessedId === undefined
      ? BOOTSTRAP_LOOKBACK_ROWS
      : needsHistoricalBackfill
        ? HISTORICAL_BACKFILL_LOOKBACK_ROWS
        : OVERLAP_LOOKBACK_ROWS;
    const afterId = Math.max(0, latestId - lookbackRows);
    const rows = db
      .prepare(
        `SELECT id, ts, thread_id, process_uuid, feedback_log_body
         FROM logs
         WHERE id > ?
           AND feedback_log_body IS NOT NULL
           AND (
             feedback_log_body LIKE '%user.email%'
             OR feedback_log_body LIKE '%event.kind=codex.rate_limits%'
             OR feedback_log_body LIKE '%"type":"codex.rate_limits"%'
             OR feedback_log_body LIKE '%"type":"error"%'
             OR feedback_log_body LIKE '%usage_limit_reached%'
             OR feedback_log_body LIKE '%status_code\":429%'
             OR feedback_log_body LIKE '%status_code\":401%'
             OR feedback_log_body LIKE '%expired token%'
             OR feedback_log_body LIKE '%unauthorized%'
             OR feedback_log_body LIKE '%rbac%'
             OR feedback_log_body LIKE '%workspace mismatch%'
             OR feedback_log_body LIKE '%workspace policy%'
             OR feedback_log_body LIKE '%organization policy%'
             OR feedback_log_body LIKE '%permission denied%'
         )
         ORDER BY id ASC
         LIMIT ${MAX_QUERY_ROWS}`,
      )
      .all(afterId) as unknown as RawHostLogRow[];

    return {
      available: true,
      latestId,
      rows: rows.map((row: RawHostLogRow) => toHostLogRow(row)),
    };
  } catch {
    return {
      available: false,
      reason: "codex-host-log-unreadable",
      rows: [],
    };
  } finally {
    db?.close();
  }
}

function findNearestContextEmail(target: ParsedHostLogRow, rows: ParsedHostLogRow[]): string | undefined {
  let best: { email: string; score: number } | undefined;

  for (const candidate of rows) {
    if (!candidate.directEmail || candidate.id === target.id) {
      continue;
    }

    const timeDistance = Math.abs(candidate.ts - target.ts);
    if (timeDistance > MAX_CONTEXT_AGE_SECONDS) {
      continue;
    }

    let channelWeight: number | undefined;
    if (target.threadId && candidate.threadId && target.threadId === candidate.threadId) {
      channelWeight = 0;
    } else if (target.processUuid && candidate.processUuid && target.processUuid === candidate.processUuid) {
      channelWeight = 10_000;
    }

    if (channelWeight === undefined) {
      continue;
    }

    const idDistance = Math.abs(candidate.id - target.id);
    if (idDistance > MAX_CONTEXT_ID_DISTANCE) {
      continue;
    }

    const score = channelWeight + idDistance;
    if (!best || score < best.score) {
      best = { email: candidate.directEmail, score };
    }
  }

  return best?.email;
}

function findNearestResolvedAlias(target: ParsedHostLogRow, rows: ParsedHostLogRow[]): string | undefined {
  let best: { alias: string; score: number } | undefined;

  for (const candidate of rows) {
    if (!candidate.resolvedAlias || candidate.id === target.id) {
      continue;
    }

    const timeDistance = Math.abs(candidate.ts - target.ts);
    if (timeDistance > MAX_CONTEXT_AGE_SECONDS) {
      continue;
    }

    let channelWeight: number | undefined;
    if (target.threadId && candidate.threadId && target.threadId === candidate.threadId) {
      channelWeight = 0;
    } else if (target.processUuid && candidate.processUuid && target.processUuid === candidate.processUuid) {
      channelWeight = 10_000;
    }

    if (channelWeight === undefined) {
      continue;
    }

    const idDistance = Math.abs(candidate.id - target.id);
    if (idDistance > MAX_CONTEXT_ID_DISTANCE) {
      continue;
    }

    const score = channelWeight + idDistance;
    if (!best || score < best.score) {
      best = { alias: candidate.resolvedAlias, score };
    }
  }

  return best?.alias;
}

function aliasFromEmail(email: string | undefined, records: AccountRecord[]): string | undefined {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return undefined;
  }

  return records.find((record: AccountRecord) => {
    const directEmail = normalizeEmail(record.meta.email);
    if (directEmail === normalized) {
      return true;
    }

    const identityEmail = normalizeEmail(extractAuthIdentity(record.snapshot.auth).email);
    return identityEmail === normalized;
  })?.meta.alias;
}

function buildActiveAliasResolver(state: Awaited<ReturnType<AccountStore["getState"]>>, events: Awaited<ReturnType<AccountStore["listEvents"]>>) {
  const switches = events
    .filter((event) => event.type === "switch" && typeof event.alias === "string")
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

  const initialAlias =
    typeof switches[0]?.details?.previousActiveAlias === "string"
      ? switches[0].details.previousActiveAlias
      : state.activeAlias;

  return (timestamp: number): string | undefined => {
    let activeAlias = initialAlias;
    for (const event of switches) {
      if (Date.parse(event.timestamp) > timestamp) {
        break;
      }
      activeAlias = event.alias;
    }
    return activeAlias;
  };
}

function buildParsedRows(
  rows: HostLogRow[],
  records: AccountRecord[],
  activeAliasAtTimestamp: (timestamp: number) => string | undefined,
): ParsedHostLogRow[] {
  const filteredRows = rows.filter((row) => isHostSignalRow(row.body));
  const allowSingleAliasFallback = records.length === 1 ? records[0]?.meta.alias : undefined;
  const parsedRows: ParsedHostLogRow[] = filteredRows.map((row: HostLogRow) => ({
    ...row,
    directEmail: extractEmailFromHostLog(row.body),
    reason: classifyFailure(row.body),
    quotaSnapshot: extractQuotaSnapshotFromText(row.body, new Date(row.ts * 1_000).toISOString()),
  }));

  for (const row of parsedRows) {
    row.contextEmail = row.directEmail ?? findNearestContextEmail(row, parsedRows);
    const aliasForContextEmail = aliasFromEmail(row.contextEmail, records);
    row.resolvedAlias =
      aliasForContextEmail ??
      (row.contextEmail ? undefined : activeAliasAtTimestamp(row.ts * 1_000) ?? allowSingleAliasFallback);
  }

  for (const row of parsedRows) {
    if (row.resolvedAlias) {
      continue;
    }

    if (row.contextEmail) {
      continue;
    }

    row.resolvedAlias =
      findNearestResolvedAlias(row, parsedRows) ??
      activeAliasAtTimestamp(row.ts * 1_000) ??
      allowSingleAliasFallback;
  }

  return parsedRows;
}

function buildHostFailureCandidatesFromParsedRows(parsedRows: ParsedHostLogRow[]): HostFailureCandidate[] {
  const candidates: HostFailureCandidate[] = [];

  for (const row of parsedRows) {
    if (!row.reason || !shouldAutoSwitch(row.reason)) {
      continue;
    }

    const email = row.contextEmail;
    const resolvedAlias = row.resolvedAlias;
    if (!resolvedAlias) {
      continue;
    }

    candidates.push({
      alias: resolvedAlias,
      reason: row.reason,
      row,
      email,
      quotaSnapshot: row.quotaSnapshot,
    });
  }

  return candidates;
}

function buildHostQuotaObservationsFromParsedRows(parsedRows: ParsedHostLogRow[]): HostQuotaObservation[] {
  const observations: HostQuotaObservation[] = [];

  for (const row of parsedRows) {
    if (!row.quotaSnapshot) {
      continue;
    }

    const email = row.contextEmail;
    const resolvedAlias = row.resolvedAlias;
    if (!resolvedAlias) {
      continue;
    }

    observations.push({
      alias: resolvedAlias,
      row,
      email,
      quotaSnapshot: row.quotaSnapshot,
    });
  }

  return observations;
}

async function enrichAccountIdentityHints(
  store: AccountStore,
  alias: string,
  details: {
    email?: string;
    planType?: string;
  },
): Promise<void> {
  if (!details.email && !details.planType) {
    return;
  }

  await store.mergeMeta(alias, {
    email: details.email,
    planType: details.planType,
  });
}

export async function reconcileHostFailover(
  store: AccountStore,
  options: ReconciliationOptions = {},
): Promise<HostReconciliationResult> {
  const allowSwitch = options.allowSwitch !== false;
  const state = await store.getState();
  if (!state.managedAuthMode) {
    return {
      available: false,
      rowsScanned: 0,
      appendedEvents: 0,
      reason: "managed-mode-disabled",
    };
  }

  const sourceResult = options.rows
    ? {
        available: true,
        latestId: options.rows.at(-1)?.id,
        rows: options.rows,
      }
    : await readHostLogRowsFromSqlite(store);

  if (!sourceResult.available) {
    await refreshAllStats(store);
    const switchedTo = await maybeSwitchBlockedAlias(store, state, allowSwitch);
    return {
      available: false,
      rowsScanned: 0,
      appendedEvents: 0,
      switchedTo,
      reason: sourceResult.reason,
    };
  }

  const existingEvents = await store.listEvents(undefined, 5_000);
  const records = await store.listAccounts();
  const activeAliasAtTimestamp = buildActiveAliasResolver(state, existingEvents);
  const parsedRows = buildParsedRows(sourceResult.rows, records, activeAliasAtTimestamp);
  const candidates = buildHostFailureCandidatesFromParsedRows(parsedRows);
  const observations = buildHostQuotaObservationsFromParsedRows(parsedRows);
  const processedHostLogIds = new Set(
    existingEvents
      .map((event) => event.details?.hostLogId)
      .filter((value): value is number => typeof value === "number"),
  );

  let appendedEvents = 0;
  let latestActiveAliasReason: FailoverReason | undefined;
  for (const candidate of candidates) {
    if (processedHostLogIds.has(candidate.row.id)) {
      continue;
    }

    await store.appendEvent({
      id: randomUUID(),
      timestamp: new Date(candidate.row.ts * 1_000).toISOString(),
      type: "limit-hit",
      alias: candidate.alias,
      reason: candidate.reason,
      details: {
        source: "codex-host-log",
        hostLogId: candidate.row.id,
        threadId: candidate.row.threadId,
        processUuid: candidate.row.processUuid,
        email: candidate.email,
        quotaSnapshot: candidate.quotaSnapshot,
      },
    });
    appendedEvents += 1;
    processedHostLogIds.add(candidate.row.id);
    await enrichAccountIdentityHints(store, candidate.alias, {
      email: candidate.email,
      planType: candidate.quotaSnapshot?.planType,
    });

    if (candidate.alias === state.activeAlias) {
      latestActiveAliasReason = candidate.reason;
    }
  }

  for (const observation of observations) {
    if (processedHostLogIds.has(observation.row.id)) {
      continue;
    }

    await store.appendEvent({
      id: randomUUID(),
      timestamp: new Date(observation.row.ts * 1_000).toISOString(),
      type: "quota-observed",
      alias: observation.alias,
      details: {
        source: "codex-host-log",
        hostLogId: observation.row.id,
        threadId: observation.row.threadId,
        processUuid: observation.row.processUuid,
        email: observation.email,
        quotaSnapshot: observation.quotaSnapshot,
      },
    });
    appendedEvents += 1;
    processedHostLogIds.add(observation.row.id);
    await enrichAccountIdentityHints(store, observation.alias, {
      email: observation.email,
      planType: observation.quotaSnapshot.planType,
    });
  }

  if (sourceResult.latestId !== undefined) {
    await store.saveHostLogState({
      lastProcessedId: sourceResult.latestId,
      updatedAt: new Date().toISOString(),
    });
  }

  await refreshAllStats(store);

  const switchedTo = await maybeSwitchBlockedAlias(store, state, allowSwitch, latestActiveAliasReason);

  return {
    available: true,
    rowsScanned: sourceResult.rows.length,
    appendedEvents,
    switchedTo,
  };
}

export async function syncHostSignalsReadOnly(
  store: AccountStore,
  options: Omit<ReconciliationOptions, "allowSwitch"> = {},
): Promise<HostReconciliationResult> {
  return reconcileHostFailover(store, {
    ...options,
    allowSwitch: false,
  });
}
