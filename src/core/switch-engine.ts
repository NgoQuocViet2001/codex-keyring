import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../platform/file-locks.js";
import type { AccountStore } from "./account-store.js";
import type { FailoverReason } from "./types.js";

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, targetPath);
}

export async function switchActiveAlias(
  store: AccountStore,
  alias: string,
  reason: FailoverReason | "manual" = "manual",
): Promise<{ backupPath?: string; autoSwitchDisabled?: boolean }> {
  const state = await store.getState();
  const meta = await store.getMeta(alias);
  const snapshot = await store.getSnapshot(alias);
  const previousActiveAlias = state.activeAlias;

  if (state.activeAlias === alias) {
    const autoSwitchDisabled = meta.manualOnly && state.autoSwitchMode !== "off";
    if (autoSwitchDisabled) {
      state.autoSwitch = false;
      state.autoSwitchMode = "off";
      await store.saveState(state);
    }
    return {
      autoSwitchDisabled,
    };
  }

  return withFileLock(store.authLockPath(), async () => {
    const backupPath = await store.backupExistingActiveAuth();
    await atomicWrite(store.env.codexAuthPath, `${JSON.stringify(snapshot.auth, null, 2)}\n`);

    state.activeAlias = alias;
    const autoSwitchDisabled = meta.manualOnly && state.autoSwitchMode !== "off";
    if (autoSwitchDisabled) {
      state.autoSwitch = false;
      state.autoSwitchMode = "off";
    }
    state.lastSwitchAt = new Date().toISOString();
    await store.saveState(state);
    await store.updateLastUsed(alias);
    await store.appendEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: "switch",
      alias,
      reason,
      details: {
        previousActiveAlias,
        backupPath,
        autoSwitchDisabled,
      },
    });

    return { backupPath, autoSwitchDisabled };
  });
}

export async function disableAutoSwitchForActiveManualOnlyAlias(store: AccountStore, alias: string): Promise<boolean> {
  const [state, meta] = await Promise.all([store.getState(), store.getMeta(alias)]);
  if (state.activeAlias !== meta.alias || !meta.manualOnly || state.autoSwitchMode === "off") {
    return false;
  }

  state.autoSwitch = false;
  state.autoSwitchMode = "off";
  await store.saveState(state);
  return true;
}

export async function restoreLastBackup(store: AccountStore): Promise<boolean> {
  const backupPath = await store.getNewestBackup();
  if (!backupPath) {
    return false;
  }

  const raw = await readFile(backupPath, "utf8");
  await atomicWrite(store.env.codexAuthPath, raw);
  await rm(backupPath, { force: true });
  return true;
}
