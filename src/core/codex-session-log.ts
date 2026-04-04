import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../platform/codex-home.js";
import type { QuotaSnapshot, QuotaWindowSnapshot } from "./types.js";

const MAX_SESSION_FILES = 12;
const MAX_SESSION_TAIL_BYTES = 512 * 1024;
const SESSION_META_HEAD_BYTES = 8 * 1024;
const DEFAULT_LOOKBACK_DAYS = 14;

interface SessionFileCandidate {
  filePath: string;
  mtimeMs: number;
}

interface SessionMetaLine {
  timestamp?: string;
  type?: string;
  payload?: {
    timestamp?: string;
  };
}

export interface SessionQuotaObservation {
  capturedAt: string;
  quotaSnapshot: QuotaSnapshot;
  sessionPath: string;
  sessionStartedAt?: string;
}

function toIsoFromEpochSeconds(value?: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return new Date((value ?? 0) * 1_000).toISOString();
}

function toQuotaWindowSnapshot(input: unknown): QuotaWindowSnapshot | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const rawUsedPercent = typeof record.used_percent === "number" ? record.used_percent : undefined;
  const rawWindowMinutes = typeof record.window_minutes === "number" ? record.window_minutes : undefined;
  if (!Number.isFinite(rawUsedPercent) || !Number.isFinite(rawWindowMinutes)) {
    return undefined;
  }

  const usedPercent = rawUsedPercent as number;
  const windowMinutes = rawWindowMinutes as number;
  const resetAtSeconds = typeof record.resets_at === "number" ? record.resets_at : undefined;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(usedPercent))),
    remainingPercent: Math.max(0, Math.min(100, Math.round(100 - usedPercent))),
    windowMinutes,
    resetAt: toIsoFromEpochSeconds(resetAtSeconds),
  };
}

export function quotaSnapshotFromSessionRateLimits(rateLimits: unknown, capturedAt: string): QuotaSnapshot | undefined {
  if (!rateLimits || typeof rateLimits !== "object" || Array.isArray(rateLimits)) {
    return undefined;
  }

  const primary = toQuotaWindowSnapshot((rateLimits as Record<string, unknown>).primary);
  const secondary = toQuotaWindowSnapshot((rateLimits as Record<string, unknown>).secondary);
  if (!primary && !secondary) {
    return undefined;
  }

  const planType = typeof (rateLimits as Record<string, unknown>).plan_type === "string"
    ? (rateLimits as Record<string, unknown>).plan_type as string
    : undefined;
  const activeLimit = typeof (rateLimits as Record<string, unknown>).limit_id === "string"
    ? (rateLimits as Record<string, unknown>).limit_id as string
    : undefined;

  return {
    capturedAt,
    source: "codex-session-log",
    activeLimit,
    planType,
    primary,
    secondary,
  };
}

async function collectSessionFiles(rootPath: string, output: SessionFileCandidate[]): Promise<void> {
  const entries = await readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(fullPath, output);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    const handle = await open(fullPath, "r");
    try {
      const fileStats = await handle.stat();
      output.push({
        filePath: fullPath,
        mtimeMs: fileStats.mtimeMs,
      });
    } finally {
      await handle.close();
    }
  }
}

async function readFileSlice(filePath: string, offset: number, length: number): Promise<string> {
  const handle = await open(filePath, "r");

  try {
    const fileStats = await handle.stat();
    const start = Math.max(0, Math.min(offset, fileStats.size));
    const bytesToRead = Math.max(0, Math.min(length, fileStats.size - start));
    if (bytesToRead === 0) {
      return "";
    }

    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readFileHead(filePath: string, maxBytes: number): Promise<string> {
  return readFileSlice(filePath, 0, maxBytes);
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");

  try {
    const fileStats = await handle.stat();
    const start = Math.max(0, fileStats.size - maxBytes);
    const bytesToRead = fileStats.size - start;
    if (bytesToRead <= 0) {
      return "";
    }

    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseSessionStartedAt(head: string): string | undefined {
  const lines = head.split(/\r?\n/u).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as SessionMetaLine;
      if (parsed.type !== "session_meta") {
        continue;
      }

      const candidates = [parsed.payload?.timestamp, parsed.timestamp];
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }

        const value = Date.parse(candidate);
        if (!Number.isNaN(value)) {
          return new Date(value).toISOString();
        }
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function extractLatestQuotaObservation(
  tail: string,
  filePath: string,
  sessionStartedAt?: string,
): SessionQuotaObservation | undefined {
  const lines = tail.split(/\r?\n/u).filter(Boolean).reverse();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: string;
        type?: string;
        payload?: {
          type?: string;
          rate_limits?: unknown;
        };
      };
      if (parsed.type !== "event_msg" || parsed.payload?.type !== "token_count") {
        continue;
      }

      const capturedAt = parsed.timestamp;
      if (!capturedAt || Number.isNaN(Date.parse(capturedAt))) {
        continue;
      }

      const quotaSnapshot = quotaSnapshotFromSessionRateLimits(parsed.payload.rate_limits, capturedAt);
      if (!quotaSnapshot) {
        continue;
      }

      return {
        capturedAt,
        quotaSnapshot,
        sessionPath: filePath,
        sessionStartedAt,
      };
    } catch {
      continue;
    }
  }

  return undefined;
}

export async function findLatestSessionQuotaObservation(
  codexHome: string,
  options: {
    since?: string;
  } = {},
): Promise<SessionQuotaObservation | undefined> {
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!(await pathExists(sessionsRoot))) {
    return undefined;
  }

  const sinceMs = options.since
    ? Date.parse(options.since)
    : Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000;
  const recentFiles: SessionFileCandidate[] = [];
  await collectSessionFiles(sessionsRoot, recentFiles);

  const candidates = recentFiles
    .filter((entry) => Number.isNaN(sinceMs) || entry.mtimeMs >= sinceMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_SESSION_FILES);

  let bestObservation: SessionQuotaObservation | undefined;

  for (const entry of candidates) {
    const head = await readFileHead(entry.filePath, SESSION_META_HEAD_BYTES);
    const sessionStartedAt = parseSessionStartedAt(head);
    if (!Number.isNaN(sinceMs) && sessionStartedAt) {
      const startedAtMs = Date.parse(sessionStartedAt);
      if (!Number.isNaN(startedAtMs) && startedAtMs < sinceMs) {
        continue;
      }
    }

    const tail = await readFileTail(entry.filePath, MAX_SESSION_TAIL_BYTES);
    const observation = extractLatestQuotaObservation(tail, entry.filePath, sessionStartedAt);
    if (!observation) {
      continue;
    }

    if (!bestObservation || Date.parse(observation.capturedAt) > Date.parse(bestObservation.capturedAt)) {
      bestObservation = observation;
    }
  }

  return bestObservation;
}
