import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AccountStore } from "../core/account-store.js";
import type { InstallResult } from "../core/types.js";
import { ensureFileBackedAuthConfig, resolvePackageRoot } from "./codex-home.js";
import { ensurePersonalMarketplaceEntry, removePersonalMarketplaceEntry } from "./marketplace.js";

const COPY_ITEMS = [".codex-plugin", ".mcp.json", "assets", "skills"];

export async function copyPluginPayload(packageRoot: string, pluginDir: string): Promise<void> {
  await mkdir(pluginDir, { recursive: true });

  for (const item of COPY_ITEMS) {
    const from = path.join(packageRoot, item);
    const to = path.join(pluginDir, item);
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
  }
}

export async function installPlugin(
  store: AccountStore,
  fromPath: string,
  manageAuth = true,
): Promise<InstallResult> {
  const packageRoot = await resolvePackageRoot(fromPath, COPY_ITEMS);
  const pluginPath = path.join(store.env.codexPluginsDir, "codex-accounts");
  await copyPluginPayload(packageRoot, pluginPath);
  await ensurePersonalMarketplaceEntry(store.env);

  const state = await store.getState();
  let managedAuthChanged = false;
  if (manageAuth) {
    const result = await ensureFileBackedAuthConfig(store.env);
    managedAuthChanged = result.changed;
    state.managedAuthMode = true;
    if (result.previousStore && result.previousStore !== "file") {
      state.originalCliAuthCredentialsStore = result.previousStore;
    }
  }
  await store.saveState(state);

  await store.appendEvent({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: "install",
    details: {
      pluginPath,
      manageAuth,
    },
  });

  return {
    pluginPath,
    marketplacePath: store.env.personalMarketplacePath,
    managedAuthChanged,
  };
}

export async function uninstallPlugin(store: AccountStore): Promise<void> {
  const pluginPath = path.join(store.env.codexPluginsDir, "codex-accounts");
  await rm(pluginPath, { recursive: true, force: true });
  await removePersonalMarketplaceEntry(store.env);

  const state = await store.getState();
  state.managedAuthMode = false;
  await store.saveState(state);

  await store.appendEvent({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: "uninstall",
    details: {
      pluginPath,
    },
  });
}
