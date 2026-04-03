import { randomUUID } from "node:crypto";
import { pathExists } from "../platform/codex-home.js";
import type { AccountStore } from "./account-store.js";
import { extractAuthIdentity } from "./auth-snapshot.js";
import { classifyFailure, pickNextAlias, shouldAutoSwitch } from "./failover-engine.js";
import { refreshAllStats } from "./stats-engine.js";
import { switchActiveAlias } from "./switch-engine.js";
import type { AccountRecord, FailoverReason } from "./types.js";

const BOOTSTRAP_LOOKBACK_ROWS = 5_000;
const MAX_QUERY_ROWS = 5_000;
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
  reason?: FailoverReason;
}

interface HostFailureCandidate {
  alias: string;
  reason: FailoverReason;
  row: HostLogRow;
  email?: string;
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

    const afterId = hostState.lastProcessedId ?? Math.max(0, latestId - BOOTSTRAP_LOOKBACK_ROWS);
    const rows = db
      .prepare(
        `SELECT id, ts, thread_id, process_uuid, feedback_log_body
         FROM logs
         WHERE id > ?
           AND feedback_log_body IS NOT NULL
           AND (
             feedback_log_body LIKE '%user.email%'
             OR feedback_log_body LIKE '%usage_limit_reached%'
             OR feedback_log_body LIKE '%usage limit%'
             OR feedback_log_body LIKE '%status_code\":429%'
             OR feedback_log_body LIKE '%rate limit%'
             OR feedback_log_body LIKE '%quota%'
             OR feedback_log_body LIKE '%expired token%'
             OR feedback_log_body LIKE '%unauthorized%'
             OR feedback_log_body LIKE '%rbac%'
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

function buildHostFailureCandidates(rows: HostLogRow[], records: AccountRecord[]): HostFailureCandidate[] {
  const parsedRows = rows.map((row: HostLogRow) => ({
    ...row,
    directEmail: extractEmailFromHostLog(row.body),
    reason: classifyFailure(row.body),
  }));

  const candidates: HostFailureCandidate[] = [];
  const allowSingleAliasFallback = records.length === 1 ? records[0]?.meta.alias : undefined;

  for (const row of parsedRows) {
    if (!row.reason || !shouldAutoSwitch(row.reason)) {
      continue;
    }

    const email = row.directEmail ?? findNearestContextEmail(row, parsedRows);
    const resolvedAlias = aliasFromEmail(email, records) ?? (email ? undefined : allowSingleAliasFallback);
    if (!resolvedAlias) {
      continue;
    }

    candidates.push({
      alias: resolvedAlias,
      reason: row.reason,
      row,
      email,
    });
  }

  return candidates;
}

export async function reconcileHostFailover(
  store: AccountStore,
  options: ReconciliationOptions = {},
): Promise<HostReconciliationResult> {
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
    return {
      available: false,
      rowsScanned: 0,
      appendedEvents: 0,
      reason: sourceResult.reason,
    };
  }

  const records = await store.listAccounts();
  const candidates = buildHostFailureCandidates(sourceResult.rows, records);
  const existingEvents = await store.listEvents(undefined, 5_000);
  const existingHostLogIds = new Set(
    existingEvents
      .map((event) => event.details?.hostLogId)
      .filter((value): value is number => typeof value === "number"),
  );

  let appendedEvents = 0;
  let latestActiveAliasReason: FailoverReason | undefined;
  for (const candidate of candidates) {
    if (existingHostLogIds.has(candidate.row.id)) {
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
      },
    });
    appendedEvents += 1;

    if (candidate.alias === state.activeAlias) {
      latestActiveAliasReason = candidate.reason;
    }
  }

  if (sourceResult.latestId !== undefined) {
    await store.saveHostLogState({
      lastProcessedId: sourceResult.latestId,
      updatedAt: new Date().toISOString(),
    });
  }

  if (appendedEvents === 0) {
    return {
      available: true,
      rowsScanned: sourceResult.rows.length,
      appendedEvents,
    };
  }

  await refreshAllStats(store);

  let switchedTo: string | undefined;
  if (state.autoSwitch && state.activeAlias && latestActiveAliasReason && shouldAutoSwitch(latestActiveAliasReason)) {
    const refreshedRecords = await store.listAccounts();
    const nextAlias = pickNextAlias(state.activeAlias, refreshedRecords);
    if (nextAlias) {
      await switchActiveAlias(store, nextAlias, latestActiveAliasReason);
      await refreshAllStats(store);
      switchedTo = nextAlias;
    }
  }

  return {
    available: true,
    rowsScanned: sourceResult.rows.length,
    appendedEvents,
    switchedTo,
  };
}
