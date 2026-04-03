import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexEnvironment } from "./codex-home.js";

interface MarketplacePluginEntry {
  name: string;
  source: {
    source: "local";
    path: string;
  };
  policy: {
    installation: "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE";
    authentication: "ON_INSTALL" | "ON_USE";
  };
  category: string;
}

interface MarketplaceFile {
  name: string;
  interface?: {
    displayName?: string;
  };
  plugins: MarketplacePluginEntry[];
}

const PLUGIN_NAME = "codex-keyring";
const LEGACY_PLUGIN_NAME = "codex-accounts";
const PLUGIN_PATH = "./.codex/plugins/codex-keyring";
const LEGACY_PLUGIN_PATH = "./.codex/plugins/codex-accounts";

function isManagedPlugin(plugin: MarketplacePluginEntry): boolean {
  return (
    plugin.name === PLUGIN_NAME ||
    plugin.name === LEGACY_PLUGIN_NAME ||
    plugin.source.path === PLUGIN_PATH ||
    plugin.source.path === LEGACY_PLUGIN_PATH
  );
}

function defaultMarketplace(): MarketplaceFile {
  return {
    name: "local-user-plugins",
    interface: {
      displayName: "Local User Plugins",
    },
    plugins: [],
  };
}

async function readMarketplace(env: CodexEnvironment): Promise<MarketplaceFile> {
  try {
    const raw = await readFile(env.personalMarketplacePath, "utf8");
    return JSON.parse(raw) as MarketplaceFile;
  } catch {
    return defaultMarketplace();
  }
}

async function writeMarketplace(env: CodexEnvironment, marketplace: MarketplaceFile): Promise<void> {
  await mkdir(path.dirname(env.personalMarketplacePath), { recursive: true });
  await writeFile(env.personalMarketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
}

export async function ensurePersonalMarketplaceEntry(env: CodexEnvironment): Promise<void> {
  const marketplace = await readMarketplace(env);
  const entry: MarketplacePluginEntry = {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: PLUGIN_PATH,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };

  const nextPlugins = marketplace.plugins.filter((plugin) => !isManagedPlugin(plugin));
  nextPlugins.push(entry);
  marketplace.plugins = nextPlugins;
  await writeMarketplace(env, marketplace);
}

export async function removePersonalMarketplaceEntry(env: CodexEnvironment): Promise<void> {
  const marketplace = await readMarketplace(env);
  marketplace.plugins = marketplace.plugins.filter((plugin) => !isManagedPlugin(plugin));
  await writeMarketplace(env, marketplace);
}

export async function hasMarketplaceEntry(env: CodexEnvironment): Promise<boolean> {
  const marketplace = await readMarketplace(env);
  return marketplace.plugins.some((plugin) => isManagedPlugin(plugin));
}
