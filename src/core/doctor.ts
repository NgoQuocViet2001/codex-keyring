import { spawnSync } from "node:child_process";
import { hasMarketplaceEntry } from "../platform/marketplace.js";
import { createCodexInvocation, getCliAuthStore, loadCodexConfig, pathExists } from "../platform/codex-home.js";
import type { AccountStore } from "./account-store.js";
import type { DoctorCheck, DoctorResult } from "./types.js";

function check(status: DoctorCheck["status"], key: string, summary: string, details?: string): DoctorCheck {
  return { status, key, summary, details };
}

export async function runDoctor(store: AccountStore): Promise<DoctorResult> {
  const [config, state, aliases, marketplaceEntry, authExists] = await Promise.all([
    loadCodexConfig(store.env),
    store.getState(),
    store.listAliases(),
    hasMarketplaceEntry(store.env),
    pathExists(store.env.codexAuthPath),
  ]);

  const checks: DoctorCheck[] = [];
  const codexInvocation = createCodexInvocation(["--version"]);
  const codexVersion = spawnSync(codexInvocation.command, codexInvocation.args, {
    encoding: "utf8",
    shell: codexInvocation.shell,
  });
  checks.push(
    codexVersion.status === 0
      ? check("pass", "codex-binary", `Codex is available: ${codexVersion.stdout.trim()}`)
      : check("fail", "codex-binary", "Codex binary is not available in PATH.", codexVersion.stderr || codexVersion.error?.message),
  );

  const authStore = getCliAuthStore(config);
  checks.push(
    authStore === "file"
      ? check("pass", "cli-auth-store", "Codex is configured for file-backed auth cache.")
      : check(
          "warn",
          "cli-auth-store",
          "Codex is not explicitly configured for file-backed auth cache.",
          `Current value: ${authStore ?? "unset/auto"}`,
        ),
  );

  checks.push(
    aliases.length > 0
      ? check("pass", "accounts", `Found ${aliases.length} registered alias(es).`)
      : check("warn", "accounts", "No managed aliases are registered yet."),
  );

  checks.push(
    marketplaceEntry
      ? check("pass", "marketplace", "Personal marketplace contains codex-accounts.")
      : check("warn", "marketplace", "Personal marketplace does not contain codex-accounts."),
  );

  checks.push(
    authExists
      ? check("pass", "active-auth", "Active Codex auth file is present.")
      : check("warn", "active-auth", "Active Codex auth file is missing."),
  );

  checks.push(
    state.activeAlias
      ? check("pass", "active-alias", `Active alias is ${state.activeAlias}.`)
      : check("warn", "active-alias", "No active alias is currently set."),
  );

  if (state.autoSwitch && authStore !== "file") {
    checks.push(
      check(
        "warn",
        "auto-switch-managed-mode",
        "Auto-switch is enabled but Codex may still be using keyring or auto storage.",
        "Run `codex-accounts install` or update ~/.codex/config.toml to file-backed auth mode.",
      ),
    );
  }

  await store.appendEvent({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: "doctor",
    details: {
      checkCount: checks.length,
    },
  });

  return {
    generatedAt: new Date().toISOString(),
    checks,
  };
}
