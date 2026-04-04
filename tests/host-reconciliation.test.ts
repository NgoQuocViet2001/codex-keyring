import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("does not proactively rebalance on passive quota observations alone when the active alias is still above threshold", async () => {
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

  it("rebalances in balanced mode when exact live quota shows the active alias below threshold", async () => {
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
      rows: [
        {
          id: 211,
          ts: 1_775_200_020,
          threadId: "thread-2",
          processUuid: "process-2",
          body: 'session metadata user.email="alice@example.com"',
        },
        {
          id: 212,
          ts: 1_775_200_021,
          threadId: "thread-2",
          processUuid: "process-2",
          body: 'websocket event: {"type":"codex.rate_limits","plan_type":"team","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":82,"window_minutes":300,"reset_after_seconds":13893,"reset_at":4070908800},"secondary":{"used_percent":12,"window_minutes":10080,"reset_after_seconds":600693,"reset_at":4071513600}}}',
        },
        {
          id: 213,
          ts: 1_775_200_022,
          threadId: "thread-3",
          processUuid: "process-3",
          body: 'session metadata user.email="bob@example.com"',
        },
        {
          id: 214,
          ts: 1_775_200_023,
          threadId: "thread-3",
          processUuid: "process-3",
          body: 'websocket event: {"type":"codex.rate_limits","plan_type":"team","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":19,"window_minutes":300,"reset_after_seconds":13893,"reset_at":4070908800},"secondary":{"used_percent":6,"window_minutes":10080,"reset_after_seconds":600693,"reset_at":4071513600}}}',
        },
      ],
    });

    expect(result.switchedTo).toBe("account2");
    expect((await store.getState()).activeAlias).toBe("account2");
  });

  it("does not attach an explicit unknown email to the currently active alias", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1", "alice@example.com"));

    const state = await store.getState();
    state.activeAlias = "account1";
    state.managedAuthMode = true;
    await store.saveState(state);

    const result = await reconcileHostFailover(store, {
      rows: [
        {
          id: 301,
          ts: 1_775_200_100,
          threadId: "thread-unknown",
          processUuid: "process-unknown",
          body: 'session metadata user.email="charlie@example.com"',
        },
        {
          id: 302,
          ts: 1_775_200_101,
          threadId: "thread-unknown",
          processUuid: "process-unknown",
          body: 'error {"type":"usage_limit_reached","status_code":429,"message":"You\'ve hit your usage limit."}',
        },
      ],
    });

    expect(result.appendedEvents).toBe(0);
    expect(await store.listEvents("account1", 20)).toHaveLength(1);
  });

  it("keeps the stored email unchanged when a known-email observation is appended", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1", "alice@example.com"));

    const state = await store.getState();
    state.managedAuthMode = true;
    await store.saveState(state);

    const result = await reconcileHostFailover(store, {
      rows: [
        {
          id: 401,
          ts: 1_775_200_020,
          threadId: "thread-solo",
          processUuid: "process-solo",
          body: 'session metadata user.email="alice@example.com"',
        },
        {
          id: 402,
          ts: 1_775_200_021,
          threadId: "thread-solo",
          processUuid: "process-solo",
          body: 'websocket event: {"type":"codex.rate_limits","plan_type":"team","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":25,"window_minutes":300,"reset_after_seconds":13893,"reset_at":1775206534},"secondary":{"used_percent":9,"window_minutes":10080,"reset_after_seconds":600693,"reset_at":1775793334}}}',
        },
      ],
    });

    expect(result.appendedEvents).toBeGreaterThan(0);
    expect((await store.getMeta("account1")).email).toBe("alice@example.com");
  });

  it("still auto-switches from a blocked active alias when the host sqlite log is unavailable", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-1", "alice@example.com"));
    await store.upsertAccount("account2", snapshot("acct-2", "bob@example.com"));

    const state = await store.getState();
    state.activeAlias = "account1";
    state.autoSwitch = true;
    state.autoSwitchMode = "sequential";
    state.managedAuthMode = true;
    state.lastSwitchAt = "2026-04-04T00:10:00.000Z";
    await store.saveState(state);

    const sessionFile = path.join(env.codexHome, "sessions", "2026", "04", "04", "session-1.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-04-04T00:05:00.000Z",
          payload: { timestamp: "2026-04-04T00:05:00.000Z" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-04-04T00:20:00.000Z",
          payload: {
            type: "token_count",
            rate_limits: {
              plan_type: "team",
              primary: {
                used_percent: 100,
                window_minutes: 300,
                resets_at: Date.parse("2999-01-01T00:00:00.000Z") / 1_000,
              },
              secondary: {
                used_percent: 15,
                window_minutes: 10_080,
                resets_at: Date.parse("2999-01-08T00:00:00.000Z") / 1_000,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await reconcileHostFailover(store);
    expect(result).toMatchObject({
      available: false,
      switchedTo: "account2",
      reason: "codex-host-log-missing",
    });
    expect((await store.getState()).activeAlias).toBe("account2");
  });
});
