import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { getCodexEnvironment, migrateLegacyKeyringHome, type CodexEnvironment, pathExists } from "../platform/codex-home.js";
import type {
  AccountMeta,
  AccountRecord,
  AccountSnapshot,
  AccountStats,
  CodexKeyringState,
  HostLogState,
  SwitchEvent,
} from "./types.js";
import { extractAuthIdentity, normalizeAuthMode, summarizeAuth } from "./auth-snapshot.js";

const STATE_FILE = "state.json";
const EVENTS_FILE = "events.jsonl";
const HOST_LOG_STATE_FILE = "host-log-state.json";

function now(): string {
  return new Date().toISOString();
}

function normalizeStatsRecord(alias: string, stats: AccountStats): AccountStats {
  return {
    ...stats,
    alias: normalizeAlias(alias),
  };
}

function defaultState(): CodexKeyringState {
  const timestamp = now();
  return {
    schemaVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    autoSwitch: false,
    managedAuthMode: false,
  };
}

function defaultHostLogState(): HostLogState {
  return {
    updatedAt: now(),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readEventLog(filePath: string): Promise<SwitchEvent[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line: string) => JSON.parse(line) as SwitchEvent);
}

async function writeEventLog(filePath: string, events: SwitchEvent[]): Promise<void> {
  const body = events.map((event: SwitchEvent) => JSON.stringify(event)).join("\n");
  await writeFile(filePath, body ? `${body}\n` : "", "utf8");
}

function resolveAliasLineage(events: SwitchEvent[], alias: string): Set<string> {
  const lineage = new Set([normalizeAlias(alias)]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const event of events) {
      const previousAlias = typeof event.details?.previousAlias === "string" ? normalizeAlias(event.details.previousAlias) : undefined;
      if (event.type === "rename-account" && event.alias && lineage.has(normalizeAlias(event.alias)) && previousAlias && !lineage.has(previousAlias)) {
        lineage.add(previousAlias);
        changed = true;
      }
    }
  }

  return lineage;
}

export function normalizeAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!normalized) {
    throw new Error("Alias must contain at least one letter or number.");
  }
  return normalized;
}

export class AccountStore {
  readonly env: CodexEnvironment;
  private readonly root: string;
  private readonly accountsDir: string;
  private readonly statsDir: string;
  private readonly backupsDir: string;
  private readonly locksDir: string;
  private readonly tmpDir: string;

  constructor(env = getCodexEnvironment()) {
    this.env = env;
    this.root = env.codexKeyringHome;
    this.accountsDir = path.join(this.root, "accounts");
    this.statsDir = path.join(this.root, "stats");
    this.backupsDir = path.join(this.root, "backups");
    this.locksDir = path.join(this.root, "locks");
    this.tmpDir = path.join(this.root, "tmp");
  }

  async ensureStore(): Promise<void> {
    await migrateLegacyKeyringHome(this.env);
    await mkdir(this.accountsDir, { recursive: true });
    await mkdir(this.statsDir, { recursive: true });
    await mkdir(this.backupsDir, { recursive: true });
    await mkdir(this.locksDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });

    if (!(await pathExists(this.statePath()))) {
      await writeJsonFile(this.statePath(), defaultState());
    }

    if (!(await pathExists(this.eventsPath()))) {
      await writeFile(this.eventsPath(), "", "utf8");
    }
  }

  statePath(): string {
    return path.join(this.root, STATE_FILE);
  }

  eventsPath(): string {
    return path.join(this.root, EVENTS_FILE);
  }

  hostLogStatePath(): string {
    return path.join(this.root, HOST_LOG_STATE_FILE);
  }

  authLockPath(): string {
    return path.join(this.locksDir, "auth.lock");
  }

  backupAuthPath(suffix: string): string {
    return path.join(this.backupsDir, `auth-${suffix}.json`);
  }

  tempLoginHome(alias: string): string {
    return path.join(this.tmpDir, `login-${normalizeAlias(alias)}-${Date.now()}`);
  }

  accountDir(alias: string): string {
    return path.join(this.accountsDir, normalizeAlias(alias));
  }

  metaPath(alias: string): string {
    return path.join(this.accountDir(alias), "meta.json");
  }

  snapshotPath(alias: string): string {
    return path.join(this.accountDir(alias), "auth.json");
  }

  statsPath(alias: string): string {
    return path.join(this.statsDir, `${normalizeAlias(alias)}.json`);
  }

  async getState(): Promise<CodexKeyringState> {
    await this.ensureStore();
    return readJsonFile<CodexKeyringState>(this.statePath());
  }

  async saveState(nextState: CodexKeyringState): Promise<void> {
    nextState.updatedAt = now();
    await writeJsonFile(this.statePath(), nextState);
  }

  async getHostLogState(): Promise<HostLogState> {
    await this.ensureStore();
    try {
      return await readJsonFile<HostLogState>(this.hostLogStatePath());
    } catch {
      return defaultHostLogState();
    }
  }

  async saveHostLogState(nextState: HostLogState): Promise<void> {
    nextState.updatedAt = now();
    await writeJsonFile(this.hostLogStatePath(), nextState);
  }

  async appendEvent(event: SwitchEvent): Promise<void> {
    await this.ensureStore();
    const enriched = {
      ...event,
      id: event.id || randomUUID(),
      timestamp: event.timestamp || now(),
    };
    await writeFile(this.eventsPath(), `${JSON.stringify(enriched)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  async listEvents(alias?: string, limit = 200): Promise<SwitchEvent[]> {
    await this.ensureStore();
    const lines = await readEventLog(this.eventsPath());
    const allowedAliases = alias ? resolveAliasLineage(lines, alias) : undefined;
    const filtered = lines.filter((event: SwitchEvent) => !allowedAliases || (event.alias ? allowedAliases.has(normalizeAlias(event.alias)) : false));
    return filtered.slice(-limit);
  }

  async getSnapshot(alias: string): Promise<AccountSnapshot> {
    return readJsonFile<AccountSnapshot>(this.snapshotPath(alias));
  }

  async getMeta(alias: string): Promise<AccountMeta> {
    return readJsonFile<AccountMeta>(this.metaPath(alias));
  }

  async getStats(alias: string): Promise<AccountStats | undefined> {
    try {
      const stats = await readJsonFile<AccountStats>(this.statsPath(alias));
      return normalizeStatsRecord(alias, stats);
    } catch {
      return undefined;
    }
  }

  async saveStats(alias: string, stats: AccountStats): Promise<void> {
    await writeJsonFile(this.statsPath(alias), normalizeStatsRecord(alias, stats));
  }

  async upsertAccount(
    alias: string,
    snapshot: AccountSnapshot,
    input: Partial<Pick<AccountMeta, "displayName" | "priority" | "notes" | "manualWindow">> = {},
  ): Promise<AccountMeta> {
    const normalizedAlias = normalizeAlias(alias);
    const existing = (await pathExists(this.metaPath(normalizedAlias))) ? await this.getMeta(normalizedAlias) : undefined;
    const timestamp = now();
    const authSummary = summarizeAuth(snapshot.auth);
    const identity = extractAuthIdentity(snapshot.auth);

    const meta: AccountMeta = {
      alias: normalizedAlias,
      displayName: input.displayName ?? existing?.displayName ?? normalizedAlias,
      priority: input.priority ?? existing?.priority ?? 100,
      notes: input.notes ?? existing?.notes,
      email: identity.email ?? existing?.email,
      organization: identity.organization ?? existing?.organization,
      planType: identity.planType ?? existing?.planType,
      fingerprint: String(authSummary.fingerprint),
      authMode: normalizeAuthMode(snapshot.auth.auth_mode),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastUsedAt: existing?.lastUsedAt,
      manualWindow: input.manualWindow ?? existing?.manualWindow,
    };

    await writeJsonFile(this.snapshotPath(normalizedAlias), snapshot);
    await writeJsonFile(this.metaPath(normalizedAlias), meta);
    await this.appendEvent({
      id: randomUUID(),
      timestamp,
      type: "add-account",
      alias: normalizedAlias,
      details: {
        authMode: meta.authMode,
        fingerprint: meta.fingerprint,
      },
    });
    return meta;
  }

  async listAliases(): Promise<string[]> {
    await this.ensureStore();
    const entries = await readdir(this.accountsDir, { withFileTypes: true });
    return entries.filter((entry: Dirent) => entry.isDirectory()).map((entry: Dirent) => entry.name).sort();
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const state = await this.getState();
    const aliases = await this.listAliases();
    const records: AccountRecord[] = [];

    for (const alias of aliases) {
      const [meta, snapshot, stats] = await Promise.all([
        this.getMeta(alias),
        this.getSnapshot(alias),
        this.getStats(alias),
      ]);
      records.push({
        meta,
        snapshot,
        stats,
        active: state.activeAlias === alias,
      });
    }

    return records.sort((left, right) => left.meta.priority - right.meta.priority || left.meta.alias.localeCompare(right.meta.alias));
  }

  async removeAccount(alias: string): Promise<void> {
    const normalizedAlias = normalizeAlias(alias);
    await rm(this.accountDir(normalizedAlias), { recursive: true, force: true });
    await rm(this.statsPath(normalizedAlias), { force: true });
    await this.appendEvent({
      id: randomUUID(),
      timestamp: now(),
      type: "remove-account",
      alias: normalizedAlias,
    });
  }

  async renameAccount(currentAlias: string, nextAlias: string): Promise<void> {
    const oldAlias = normalizeAlias(currentAlias);
    const newAlias = normalizeAlias(nextAlias);
    if (oldAlias === newAlias) {
      return;
    }

    await rename(this.accountDir(oldAlias), this.accountDir(newAlias));
    if (await pathExists(this.statsPath(oldAlias))) {
      await rename(this.statsPath(oldAlias), this.statsPath(newAlias));
      const renamedStats = await this.getStats(newAlias);
      if (renamedStats) {
        await this.saveStats(newAlias, renamedStats);
      }
    }

    const events = await readEventLog(this.eventsPath());
    const renamedEvents = events.map((event: SwitchEvent) =>
      event.alias === oldAlias
        ? {
            ...event,
            alias: newAlias,
          }
        : event,
    );
    await writeEventLog(this.eventsPath(), renamedEvents);

    const meta = await this.getMeta(newAlias);
    meta.alias = newAlias;
    meta.displayName = meta.displayName === oldAlias ? newAlias : meta.displayName;
    meta.updatedAt = now();
    await writeJsonFile(this.metaPath(newAlias), meta);

    const state = await this.getState();
    if (state.activeAlias === oldAlias) {
      state.activeAlias = newAlias;
      await this.saveState(state);
    }

    await this.appendEvent({
      id: randomUUID(),
      timestamp: now(),
      type: "rename-account",
      alias: newAlias,
      details: {
        previousAlias: oldAlias,
      },
    });
  }

  async updateLastUsed(alias: string): Promise<void> {
    const meta = await this.getMeta(alias);
    meta.lastUsedAt = now();
    meta.updatedAt = now();
    await writeJsonFile(this.metaPath(alias), meta);
  }

  async backupExistingActiveAuth(): Promise<string | undefined> {
    if (!(await pathExists(this.env.codexAuthPath))) {
      return undefined;
    }

    const backupPath = this.backupAuthPath(Date.now().toString());
    const raw = await readFile(this.env.codexAuthPath, "utf8");
    await writeFile(backupPath, raw, "utf8");
    return backupPath;
  }

  async getNewestBackup(): Promise<string | undefined> {
    const entries = await readdir(this.backupsDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry: Dirent) => entry.isFile())
        .map(async (entry: Dirent) => ({
          fullPath: path.join(this.backupsDir, entry.name),
          stats: await stat(path.join(this.backupsDir, entry.name)),
        })),
    );
    return files.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0]?.fullPath;
  }
}
