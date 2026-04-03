import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/core/account-store.js";
import { refreshStatsForAlias } from "../src/core/stats-engine.js";
import type { AccountSnapshot, QuotaSnapshot } from "../src/core/types.js";
import type { CodexEnvironment } from "../src/platform/codex-home.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function createEnv(root: string): CodexEnvironment {
  const userHome = path.join(root, "home");
  const codexHome = path.join(userHome, ".codex");
  return {
    userHome,
    codexHome,
    codexAuthPath: path.join(codexHome, "auth.json"),
    codexConfigPath: path.join(codexHome, "config.toml"),
    codexLogDir: path.join(codexHome, "log"),
    codexLogsDbPath: path.join(codexHome, "logs_1.sqlite"),
    codexPluginsDir: path.join(codexHome, "plugins"),
    personalMarketplacePath: path.join(userHome, ".agents", "plugins", "marketplace.json"),
    personalMarketplaceRoot: userHome,
    codexKeyringHome: path.join(userHome, ".codex-keyring"),
    legacyCodexAccountsHome: path.join(userHome, ".codex-accounts"),
  };
}

function snapshot(accountId: string): AccountSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: "active-auth",
    auth: {
      auth_mode: "chatgpt",
      tokens: {
        account_id: accountId,
      },
    },
  };
}

function quotaSnapshot(capturedAt: string, remaining5h: number, remainingWeek: number): QuotaSnapshot {
  return {
    capturedAt,
    source: "codex-host-log",
    primary: {
      usedPercent: 100 - remaining5h,
      remainingPercent: remaining5h,
      windowMinutes: 300,
      resetAt: "2999-01-01T00:00:00.000Z",
    },
    secondary: {
      usedPercent: 100 - remainingWeek,
      remainingPercent: remainingWeek,
      windowMinutes: 10_080,
      resetAt: "2999-01-08T00:00:00.000Z",
    },
  };
}

describe("stats-engine", () => {
  it("recovers account health after a newer positive quota observation", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1"));

    const limitHitAt = "2026-04-03T08:00:00.000Z";
    const recoveredAt = "2026-04-03T08:30:00.000Z";

    await store.appendEvent({
      id: randomUUID(),
      timestamp: limitHitAt,
      type: "limit-hit",
      alias: "account1",
      reason: "rate-limited",
      details: {
        quotaSnapshot: quotaSnapshot(limitHitAt, 0, 87),
      },
    });
    await store.appendEvent({
      id: randomUUID(),
      timestamp: recoveredAt,
      type: "quota-observed",
      alias: "account1",
      details: {
        quotaSnapshot: quotaSnapshot(recoveredAt, 78, 85),
      },
    });

    const stats = await refreshStatsForAlias(store, "account1");
    expect(stats.limit5hRemainingPercent).toBe(78);
    expect(stats.limitWeekRemainingPercent).toBe(85);
    expect(stats.health).toBe("ready");
    expect(stats.notes).toContain("recovered headroom");
  });
});
