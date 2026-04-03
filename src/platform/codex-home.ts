import * as TOML from "@iarna/toml";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodexEnvironment {
  userHome: string;
  codexHome: string;
  codexAuthPath: string;
  codexConfigPath: string;
  codexLogDir: string;
  codexLogsDbPath: string;
  codexPluginsDir: string;
  personalMarketplacePath: string;
  personalMarketplaceRoot: string;
  codexAccountsHome: string;
}

export interface ManagedAuthResult {
  changed: boolean;
  previousStore?: string;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  shell?: boolean;
}

export function createCodexInvocationForPlatform(platform: NodeJS.Platform, args: string[]): CommandInvocation {
  if (platform === "win32") {
    const escape = (value: string): string => {
      if (/[\s"]/u.test(value)) {
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    };

    return {
      command: ["codex", ...args].map(escape).join(" "),
      args: [],
      shell: true,
    };
  }

  return {
    command: "codex",
    args,
      shell: false,
  };
}

export function createCodexInvocation(args: string[]): CommandInvocation {
  return createCodexInvocationForPlatform(process.platform, args);
}

export function getCodexEnvironment(customCodexHome?: string): CodexEnvironment {
  const userHome = os.homedir();
  const codexHome = customCodexHome ?? process.env.CODEX_HOME ?? path.join(userHome, ".codex");

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

export async function loadCodexConfig(env: CodexEnvironment): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(env.codexConfigPath, "utf8");
    return TOML.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function saveCodexConfig(env: CodexEnvironment, config: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(env.codexConfigPath), { recursive: true });
  await writeFile(env.codexConfigPath, TOML.stringify(config as never), "utf8");
}

export function getCliAuthStore(config: Record<string, unknown>): string | undefined {
  const value = config.cli_auth_credentials_store;
  return typeof value === "string" ? value : undefined;
}

export async function ensureFileBackedAuthConfig(env: CodexEnvironment): Promise<ManagedAuthResult> {
  const config = await loadCodexConfig(env);
  const previousStore = getCliAuthStore(config);

  if (previousStore === "file") {
    return { changed: false, previousStore };
  }

  config.cli_auth_credentials_store = "file";
  const codexAccounts = ((config.codex_accounts as Record<string, unknown> | undefined) ?? {});
  codexAccounts.managed_by = "codex-accounts";
  codexAccounts.updated_at = new Date().toISOString();
  config.codex_accounts = codexAccounts;

  await saveCodexConfig(env, config);
  return { changed: true, previousStore };
}

export async function restoreCliAuthStore(env: CodexEnvironment, previousStore?: string): Promise<boolean> {
  if (!previousStore) {
    return false;
  }

  const config = await loadCodexConfig(env);
  config.cli_auth_credentials_store = previousStore;
  await saveCodexConfig(env, config);
  return true;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasRequiredEntries(rootPath: string, requiredEntries: string[]): Promise<boolean> {
  if (requiredEntries.length === 0) {
    return true;
  }

  const checks = await Promise.all(requiredEntries.map((entry: string) => pathExists(path.join(rootPath, entry))));
  return checks.every(Boolean);
}

export async function resolvePackageRoot(fromPath: string, requiredEntries: string[] = []): Promise<string> {
  let current = path.resolve(fromPath);

  while (true) {
    const candidate = path.join(current, "package.json");
    if ((await pathExists(candidate)) && (await hasRequiredEntries(current, requiredEntries))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve package root from ${fromPath}`);
    }
    current = parent;
  }
}
