import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function snapshot(accountId: string, email = `${accountId}@example.com`): AccountSnapshot {
  const idPayload = {
    email,
    name: email.split("@")[0],
  };
  const idToken = `header.${Buffer.from(JSON.stringify(idPayload)).toString("base64url")}.signature`;

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: "active-auth",
    auth: {
      auth_mode: "chatgpt",
      tokens: {
        account_id: accountId,
        id_token: idToken,
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

  it("reuses quota observations that were historically attached to another alias when the email matches", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("ngoquocviet2001-outlook", snapshot("acct-outlook", "ngoquocviet2001@outlook.com"));

    const observedAt = "2026-04-04T03:00:00.000Z";
    await store.appendEvent({
      id: randomUUID(),
      timestamp: observedAt,
      type: "quota-observed",
      alias: "hinadau04",
      details: {
        email: "ngoquocviet2001@outlook.com",
        quotaSnapshot: quotaSnapshot(observedAt, 61, 84),
      },
    });

    const stats = await refreshStatsForAlias(store, "ngoquocviet2001-outlook");
    expect(stats.limit5hRemainingPercent).toBe(61);
    expect(stats.limitWeekRemainingPercent).toBe(84);
    expect(stats.quotaSource).toBe("codex-host-log");
  });

  it("prefers a fresher active session quota snapshot even when the session started before the last switch", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1"));

    const state = await store.getState();
    state.activeAlias = "account1";
    state.lastSwitchAt = "2026-04-04T00:50:00.000Z";
    await store.saveState(state);

    await store.appendEvent({
      id: randomUUID(),
      timestamp: "2026-04-04T00:30:00.000Z",
      type: "quota-observed",
      alias: "account1",
      details: {
        quotaSnapshot: quotaSnapshot("2026-04-04T00:30:00.000Z", 12, 75),
      },
    });

    const sessionFile = path.join(env.codexHome, "sessions", "2026", "04", "04", "session-1.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-04-04T00:45:00.000Z",
          payload: { timestamp: "2026-04-04T00:45:00.000Z" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-04-04T01:05:00.000Z",
          payload: {
            type: "token_count",
            rate_limits: {
              plan_type: "team",
              primary: {
                used_percent: 23,
                window_minutes: 300,
                resets_at: Date.parse("2999-01-01T00:00:00.000Z") / 1_000,
              },
              secondary: {
                used_percent: 12,
                window_minutes: 10_080,
                resets_at: Date.parse("2999-01-08T00:00:00.000Z") / 1_000,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const stats = await refreshStatsForAlias(store, "account1");
    expect(stats.limit5hRemainingPercent).toBe(77);
    expect(stats.limitWeekRemainingPercent).toBe(88);
    expect(stats.quotaSource).toBe("codex-session-log");
  });

  it("drops stale quota windows after their reset time has already passed", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1"));

    await store.appendEvent({
      id: randomUUID(),
      timestamp: "2026-04-03T01:00:00.000Z",
      type: "quota-observed",
      alias: "account1",
      details: {
        quotaSnapshot: {
          capturedAt: "2026-04-03T01:00:00.000Z",
          source: "codex-host-log",
          primary: {
            usedPercent: 100,
            remainingPercent: 0,
            windowMinutes: 300,
            resetAt: "2026-04-03T02:00:00.000Z",
          },
          secondary: {
            usedPercent: 70,
            remainingPercent: 30,
            windowMinutes: 10_080,
            resetAt: "2026-04-03T02:00:00.000Z",
          },
        } satisfies QuotaSnapshot,
      },
    });

    const stats = await refreshStatsForAlias(store, "account1");
    expect(stats.limit5hRemainingPercent).toBeUndefined();
    expect(stats.limitWeekRemainingPercent).toBeUndefined();
    expect(stats.quotaObservedAt).toBeUndefined();
    expect(stats.confidence).toBe("estimated");
    expect(stats.notes).toContain("waiting for a fresh Codex signal");
  });
});
