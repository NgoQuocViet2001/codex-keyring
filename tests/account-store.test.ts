import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/core/account-store.js";
import { refreshStatsForAlias } from "../src/core/stats-engine.js";
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

describe("account-store rename and stats lifecycle", () => {
  it("renames stats and event history with the alias", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("main", snapshot("acct-main"));

    const state = await store.getState();
    state.activeAlias = "main";
    await store.saveState(state);

    const successAt = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    const limitHitAt = new Date(Date.now() - 5 * 60 * 1_000).toISOString();
    await store.appendEvent({ id: randomUUID(), timestamp: successAt, type: "exec-success", alias: "main" });
    await store.appendEvent({
      id: randomUUID(),
      timestamp: limitHitAt,
      type: "limit-hit",
      alias: "main",
      reason: "rate-limited",
    });
    await store.saveStats("main", {
      alias: "main",
      authMode: "chatgpt",
      active: true,
      health: "cooldown",
      confidence: "exact",
      lastSuccessAt: successAt,
      lastLimitHitAt: limitHitAt,
      cooldownUntil: new Date(Date.parse(limitHitAt) + 30 * 60 * 1_000).toISOString(),
      windowType: "rolling-24h",
    });

    await store.renameAccount("main", "hinadau04");

    expect(await store.getStats("hinadau04")).toMatchObject({
      alias: "hinadau04",
      lastLimitHitAt: limitHitAt,
    });
    expect(await store.listEvents("main")).toHaveLength(0);
    expect(await store.listEvents("hinadau04")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: "hinadau04", type: "exec-success" }),
        expect.objectContaining({ alias: "hinadau04", type: "limit-hit" }),
        expect.objectContaining({ alias: "hinadau04", type: "rename-account" }),
      ]),
    );

    const refreshed = await refreshStatsForAlias(store, "hinadau04");
    expect(refreshed.alias).toBe("hinadau04");
    expect(refreshed.lastSuccessAt).toBe(successAt);
    expect(refreshed.lastLimitHitAt).toBe(limitHitAt);
    expect(refreshed.health).toBe("cooldown");
  });

  it("resets derived stats when an alias is re-registered for a different account", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("account1", snapshot("acct-one"));
    await store.appendEvent({
      id: randomUUID(),
      timestamp: new Date(Date.now() - 5 * 60 * 1_000).toISOString(),
      type: "exec-success",
      alias: "account1",
    });

    const beforeReplace = await refreshStatsForAlias(store, "account1");
    expect(beforeReplace.estimatedRequestsThisWindow).toBe(1);

    await store.upsertAccount("account1", snapshot("acct-two"));

    const afterReplace = await refreshStatsForAlias(store, "account1");
    expect(afterReplace.alias).toBe("account1");
    expect(afterReplace.lastLimitHitAt).toBeUndefined();
    expect(afterReplace.estimatedRequestsThisWindow).toBeUndefined();
  });

  it("keeps old event history visible after rename for stores created before the fix", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexAuthPath), { recursive: true });

    const store = new AccountStore(env);
    await store.upsertAccount("main", snapshot("acct-main"));
    await store.appendEvent({
      id: randomUUID(),
      timestamp: new Date(Date.now() - 5 * 60 * 1_000).toISOString(),
      type: "exec-success",
      alias: "main",
    });

    await store.renameAccount("main", "hinadau04");

    const events = (await readFile(store.eventsPath(), "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line: string) => JSON.parse(line) as { alias?: string; type: string });
    const legacyEvents = events.map((event) =>
      event.type === "rename-account"
        ? event
        : {
            ...event,
            alias: "main",
          },
    );
    await writeFile(store.eventsPath(), `${legacyEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const refreshed = await refreshStatsForAlias(store, "hinadau04");
    expect(refreshed.lastSuccessAt).toBeDefined();
    expect(refreshed.alias).toBe("hinadau04");
  });
});
