import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/core/account-store.js";
import { getAccountInfoView, getStatusView, listAccountsWithFreshStats } from "../src/core/account-views.js";
import type { AccountSnapshot, CodexEnvironment } from "../src/core/types.js";

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
    codexAccountsHome: path.join(userHome, ".codex-accounts"),
  };
}

function snapshot(): AccountSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: "active-auth",
    auth: {
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct-123",
        access_token: "secret-access-token",
        refresh_token: "secret-refresh-token",
      },
    },
  };
}

function snapshotWithTeamClaims(): AccountSnapshot {
  const accessPayload = {
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "team",
      organizations: [
        {
          title: "Personal",
          is_default: true,
        },
      ],
    },
    "https://api.openai.com/profile": {
      email: "alice@example.com",
    },
  };
  const idPayload = {
    email: "alice@example.com",
    name: "Alice",
  };
  const accessToken = `header.${Buffer.from(JSON.stringify(accessPayload)).toString("base64url")}.signature`;
  const idToken = `header.${Buffer.from(JSON.stringify(idPayload)).toString("base64url")}.signature`;

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: "active-auth",
    auth: {
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct-team",
        access_token: accessToken,
        id_token: idToken,
      },
    },
  };
}

describe("account-views", () => {
  it("returns sanitized account list data", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot());

    const records = await listAccountsWithFreshStats(store);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      alias: "account1",
      authMode: "chatgpt",
      fingerprint: expect.any(String),
    });
    expect(records[0]).not.toHaveProperty("snapshot");
    expect(JSON.stringify(records[0])).not.toContain("secret-access-token");
    expect(JSON.stringify(records[0])).not.toContain("secret-refresh-token");
  });

  it("returns sanitized status data", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot());

    const payload = await getStatusView(store);
    expect(payload.aliases).toEqual([
      expect.objectContaining({
        alias: "account1",
        authMode: "chatgpt",
        fingerprint: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("secret-access-token");
    expect(JSON.stringify(payload)).not.toContain("secret-refresh-token");
  });

  it("returns safe account info for one alias", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot());

    const payload = await getAccountInfoView(store, "account1");
    expect(payload).toMatchObject({
      alias: "account1",
      email: undefined,
      organization: undefined,
      planType: undefined,
      authMode: "chatgpt",
    });
    expect(JSON.stringify(payload)).not.toContain("secret-access-token");
    expect(JSON.stringify(payload)).not.toContain("secret-refresh-token");
  });

  it("hides ambiguous Personal organization labels for team plans", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshotWithTeamClaims());

    const payload = await getAccountInfoView(store, "account1");
    expect(payload).toMatchObject({
      alias: "account1",
      email: "alice@example.com",
      organization: undefined,
      planType: "team",
    });
  });
});
