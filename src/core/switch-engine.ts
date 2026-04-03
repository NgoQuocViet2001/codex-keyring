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
): Promise<{ backupPath?: string }> {
  const state = await store.getState();
  if (state.activeAlias === alias) {
    return {};
  }

  const snapshot = await store.getSnapshot(alias);
  const previousActiveAlias = state.activeAlias;

  return withFileLock(store.authLockPath(), async () => {
    const backupPath = await store.backupExistingActiveAuth();
    await atomicWrite(store.env.codexAuthPath, `${JSON.stringify(snapshot.auth, null, 2)}\n`);

    state.activeAlias = alias;
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
      },
    });

    return { backupPath };
  });
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
