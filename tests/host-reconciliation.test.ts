import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/core/account-store.js";
import { reconcileHostFailover, type HostLogRow } from "../src/core/host-reconciliation.js";
import type { AccountSnapshot } from "../src/core/types.js";
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

function snapshot(accountId: string, email: string): AccountSnapshot {
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

function hostRows(): HostLogRow[] {
  return [
    {
      id: 101,
      ts: 1_775_200_000,
      threadId: "thread-1",
      processUuid: "process-1",
      body: 'session metadata user.email="alice@example.com"',
    },
    {
      id: 102,
      ts: 1_775_200_001,
      threadId: "thread-1",
      processUuid: "process-1",
      body: 'websocket event: {"type":"codex.rate_limits","plan_type":"team","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":42,"window_minutes":300,"reset_after_seconds":13893,"reset_at":1775206534},"secondary":{"used_percent":5,"window_minutes":10080,"reset_after_seconds":600693,"reset_at":1775793334}}}',
    },
    {
      id: 103,
      ts: 1_775_200_002,
      threadId: "thread-1",
      processUuid: "process-1",
      body: 'error {"type":"usage_limit_reached","status_code":429,"message":"You\'ve hit your usage limit."}',
    },
  ];
}

function quotaOnlyRows(): HostLogRow[] {
  return [
    {
      id: 201,
      ts: 1_775_200_010,
      threadId: "thread-2",
      processUuid: "process-2",
      body: 'session metadata user.email="alice@example.com"',
    },
    {
      id: 202,
      ts: 1_775_200_011,
      threadId: "thread-2",
      processUuid: "process-2",
      body: 'websocket event: {"type":"codex.rate_limits","plan_type":"team","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":58,"window_minutes":300,"reset_after_seconds":13893,"reset_at":1775206534},"secondary":{"used_percent":5,"window_minutes":10080,"reset_after_seconds":600693,"reset_at":1775793334}}}',
    },
    {
      id: 203,
      ts: 1_775_200_012,
      threadId: "thread-3",
      processUuid: "process-3",
      body: 'session metadata user.email="bob@example.com"',
    },
    {
      id: 204,
      ts: 1_775_200_013,
      threadId: "thread-3",
      processUuid: "process-3",
      body: 'websocket event: {"type":"codex.rate_limits","plan_type":"team","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":12,"window_minutes":300,"reset_after_seconds":13893,"reset_at":1775206534},"secondary":{"used_percent":3,"window_minutes":10080,"reset_after_seconds":600693,"reset_at":1775793334}}}',
    },
  ];
}

describe("host-reconciliation", () => {
  it("records host-side limit hits and auto-switches the next active alias", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1", "alice@example.com"));
    await store.upsertAccount("account2", snapshot("acct-2", "bob@example.com"));

    const state = await store.getState();
    state.activeAlias = "account1";
    state.autoSwitch = true;
    state.managedAuthMode = true;
    await store.saveState(state);

    const result = await reconcileHostFailover(store, { rows: hostRows() });
    expect(result).toMatchObject({
      available: true,
      appendedEvents: 2,
      switchedTo: "account2",
    });

    const nextState = await store.getState();
    expect(nextState.activeAlias).toBe("account2");

    const events = await store.listEvents("account1", 20);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alias: "account1",
          type: "limit-hit",
          reason: "quota-exhausted",
          details: expect.objectContaining({
            source: "codex-host-log",
            hostLogId: 103,
            email: "alice@example.com",
          }),
        }),
      ]),
    );
  });

  it("deduplicates already-processed host rows", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1", "alice@example.com"));

    const state = await store.getState();
    state.activeAlias = "account1";
    state.managedAuthMode = true;
    await store.saveState(state);

    const first = await reconcileHostFailover(store, { rows: hostRows() });
    const second = await reconcileHostFailover(store, { rows: hostRows() });

    expect(first.appendedEvents).toBeGreaterThan(1);
    expect(second.appendedEvents).toBe(0);
    expect(await store.listEvents("account1", 20)).toHaveLength(3);
  });

  it("can sync host rows without switching the active alias", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1", "alice@example.com"));
    await store.upsertAccount("account2", snapshot("acct-2", "bob@example.com"));

    const state = await store.getState();
    state.activeAlias = "account1";
    state.autoSwitch = true;
    state.autoSwitchMode = "balanced";
    state.managedAuthMode = true;
    await store.saveState(state);

    const result = await reconcileHostFailover(store, {
      rows: hostRows(),
      allowSwitch: false,
    });
    expect(result.appendedEvents).toBeGreaterThan(0);
    expect(result.switchedTo).toBeUndefined();
    expect((await store.getState()).activeAlias).toBe("account1");
  });

  it("does not proactively rebalance on passive quota observations alone", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1", "alice@example.com"));
    await store.upsertAccount("account2", snapshot("acct-2", "bob@example.com"));

    const state = await store.getState();
    state.activeAlias = "account1";
    state.autoSwitch = true;
    state.autoSwitchMode = "balanced";
    state.managedAuthMode = true;
    await store.saveState(state);

    const result = await reconcileHostFailover(store, { rows: quotaOnlyRows() });
    expect(result.switchedTo).toBeUndefined();
    expect((await store.getState()).activeAlias).toBe("account1");
  });
});
