import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/core/account-store.js";
import { disableAutoSwitchForActiveManualOnlyAlias, switchActiveAlias } from "../src/core/switch-engine.js";
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

describe("switch-engine", () => {
  it("turns auto-switch off when manually switching to a manual-only alias", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("auto-alias", snapshot("acct-auto"));
    await store.upsertAccount("manual-alias", snapshot("acct-manual"), { manualOnly: true });

    const state = await store.getState();
    state.activeAlias = "auto-alias";
    state.autoSwitch = true;
    state.autoSwitchMode = "balanced";
    await store.saveState(state);

    const result = await switchActiveAlias(store, "manual-alias", "manual");
    const nextState = await store.getState();

    expect(result.autoSwitchDisabled).toBe(true);
    expect(nextState.activeAlias).toBe("manual-alias");
    expect(nextState.autoSwitch).toBe(false);
    expect(nextState.autoSwitchMode).toBe("off");
  });

  it("turns auto-switch off when the active alias is later marked manual-only", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("manual-alias", snapshot("acct-manual"));

    const state = await store.getState();
    state.activeAlias = "manual-alias";
    state.autoSwitch = true;
    state.autoSwitchMode = "sequential";
    await store.saveState(state);

    await store.setManualOnly("manual-alias", true);
    const disabled = await disableAutoSwitchForActiveManualOnlyAlias(store, "manual-alias");
    const nextState = await store.getState();

    expect(disabled).toBe(true);
    expect(nextState.autoSwitch).toBe(false);
    expect(nextState.autoSwitchMode).toBe("off");
  });
});
