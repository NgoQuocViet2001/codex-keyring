import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexInvocationForPlatform,
  ensureFileBackedAuthConfig,
  migrateLegacyKeyringHome,
  pathExists,
  resolvePackageRoot,
  type CodexEnvironment,
} from "../src/platform/codex-home.js";

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

describe("resolvePackageRoot", () => {
  it("skips nested dist package.json when required payload entries only exist at the package root", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));

    const packageRoot = path.join(tempDir, "package-root");
    const distRoot = path.join(packageRoot, "dist");
    const commandRoot = path.join(distRoot, "src", "cli", "commands");

    await mkdir(commandRoot, { recursive: true });
    await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
    await mkdir(path.join(packageRoot, "assets"), { recursive: true });
    await mkdir(path.join(packageRoot, "skills"), { recursive: true });

    await writeFile(path.join(packageRoot, "package.json"), "{}\n", "utf8");
    await writeFile(path.join(packageRoot, ".mcp.json"), "{}\n", "utf8");
    await writeFile(path.join(distRoot, "package.json"), "{}\n", "utf8");

    const resolved = await resolvePackageRoot(commandRoot, [".codex-plugin", ".mcp.json", "assets", "skills"]);
    expect(resolved).toBe(packageRoot);
  });
});

describe("createCodexInvocationForPlatform", () => {
  it("builds a shell command for Windows Codex invocations", () => {
    const invocation = createCodexInvocationForPlatform("win32", ["login", "-c", 'cli_auth_credentials_store="file"']);

    expect(invocation).toEqual({
      command: 'codex login -c "cli_auth_credentials_store=\\"file\\""',
      args: [],
      shell: true,
    });
  });

  it.each(["linux", "darwin"] satisfies NodeJS.Platform[])(
    "uses direct binary invocation on %s",
    (platform: NodeJS.Platform) => {
      const invocation = createCodexInvocationForPlatform(platform, ["--version"]);

      expect(invocation).toEqual({
        command: "codex",
        args: ["--version"],
        shell: false,
      });
    },
  );
});

describe("keyring migration", () => {
  it("moves the legacy store folder to the new keyring path", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.join(env.legacyCodexAccountsHome, "accounts"), { recursive: true });
    await writeFile(path.join(env.legacyCodexAccountsHome, "state.json"), "{}\n", "utf8");

    const migrated = await migrateLegacyKeyringHome(env);

    expect(migrated).toBe(true);
    expect(await pathExists(env.codexKeyringHome)).toBe(true);
    expect(await pathExists(env.legacyCodexAccountsHome)).toBe(false);
  });

  it("writes managed mode metadata under codex_keyring and removes the legacy config key", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const env = createEnv(tempDir);
    await mkdir(path.dirname(env.codexConfigPath), { recursive: true });
    await writeFile(
      env.codexConfigPath,
      'cli_auth_credentials_store = "keychain"\n[codex_accounts]\nmanaged_by = "codex-accounts"\n',
      "utf8",
    );

    const result = await ensureFileBackedAuthConfig(env);
    const config = await readFile(env.codexConfigPath, "utf8");

    expect(result).toEqual({
      changed: true,
      previousStore: "keychain",
    });
    expect(config).toContain("[codex_keyring]");
    expect(config).toContain('managed_by = "codex-keyring"');
    expect(config).not.toContain("[codex_accounts]");
  });
});
