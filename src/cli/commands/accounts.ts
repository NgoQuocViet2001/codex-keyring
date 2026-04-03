import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { normalizeAlias } from "../../core/account-store.js";
import { getAccountInfoView, getStatusView, listAccountsWithFreshStats } from "../../core/account-views.js";
import { captureSnapshot } from "../../core/auth-snapshot.js";
import { runDoctor } from "../../core/doctor.js";
import { refreshAllStats, refreshStatsForAlias } from "../../core/stats-engine.js";
import { switchActiveAlias } from "../../core/switch-engine.js";
import { createCodexInvocation } from "../../platform/codex-home.js";
import type { CliContext } from "../context.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log("No records.");
    return;
  }
  console.table(rows);
}

function printInfo(record: Record<string, unknown>): void {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined && value !== "");
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of entries) {
    if (value === undefined || value === "") {
      continue;
    }
    console.log(`${key.padEnd(width)} : ${String(value)}`);
  }
}

async function runCodexLogin(tempHome: string, deviceAuth: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = ["login", "-c", 'cli_auth_credentials_store="file"'];
    if (deviceAuth) {
      args.push("--device-auth");
    }
    const invocation = createCodexInvocation(args);

    const child = spawn(invocation.command, invocation.args, {
      env: {
        ...process.env,
        CODEX_HOME: tempHome,
      },
      shell: invocation.shell,
      stdio: "inherit",
    });

    child.on("exit", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`codex login exited with code ${code ?? -1}`));
    });
    child.on("error", reject);
  });
}

export function registerAccountCommands(program: Command, context: CliContext): void {
  program
    .command("list")
    .description("List registered aliases and account health")
    .option("--json", "Emit JSON output")
    .action(async (options: { json?: boolean }) => {
      const records = await listAccountsWithFreshStats(context.store);
      if (options.json) {
        printJson(records);
        return;
      }

      const showOrganization = records.some((record) => Boolean(record.organization));
      const showPlanType = records.some((record) => Boolean(record.planType));

      printTable(
        records.map((record) => {
          const row: Record<string, unknown> = {
            alias: record.alias,
            email: record.email ?? "",
          };
          if (showOrganization) {
            row.organization = record.organization ?? "";
          }
          if (showPlanType) {
            row.planType = record.planType ?? "";
          }
          row.active = record.active;
          row.authMode = record.authMode;
          row.priority = record.priority;
          row.health = record.health;
          row.confidence = record.confidence;
          row.fingerprint = record.fingerprint;
          return row;
        }),
      );
    });

  program
    .command("status")
    .description("Show high-level managed state")
    .option("--json", "Emit JSON output")
    .action(async (options: { json?: boolean }) => {
      const payload = await getStatusView(context.store);

      if (options.json) {
        printJson(payload);
        return;
      }

      console.log(`Active alias : ${payload.state.activeAlias ?? "(none)"}`);
      console.log(`Auto-switch  : ${payload.state.autoSwitch ? "on" : "off"}`);
      console.log(`Managed mode : ${payload.state.managedAuthMode ? "on" : "off"}`);
      printTable(payload.aliases as unknown as Array<Record<string, unknown>>);
    });

  program
    .command("stats")
    .description("Show account health and limit-confidence data")
    .argument("[alias]", "Specific alias to inspect")
    .option("--json", "Emit JSON output")
    .action(async (alias: string | undefined, options: { json?: boolean }) => {
      if (alias) {
        const stats = await refreshStatsForAlias(context.store, normalizeAlias(alias));
        if (options.json) {
          printJson(stats);
          return;
        }
        printTable([stats as unknown as Record<string, unknown>]);
        return;
      }

      const stats = await refreshAllStats(context.store);
      if (options.json) {
        printJson(stats);
        return;
      }
      printTable(stats as unknown as Array<Record<string, unknown>>);
    });

  program
    .command("info")
    .description("Show safe details for one alias")
    .argument("<alias>", "Alias to inspect")
    .option("--json", "Emit JSON output")
    .action(async (alias: string, options: { json?: boolean }) => {
      const payload = await getAccountInfoView(context.store, normalizeAlias(alias));
      if (options.json) {
        printJson(payload);
        return;
      }
      printInfo(payload as unknown as Record<string, unknown>);
    });

  program
    .command("auto")
    .description("Enable or disable supported auto-switch")
    .argument("<mode>", "on or off")
    .action(async (mode: string) => {
      const normalizedMode = mode.trim().toLowerCase();
      if (normalizedMode !== "on" && normalizedMode !== "off") {
        throw new Error("Mode must be `on` or `off`.");
      }

      const state = await context.store.getState();
      state.autoSwitch = normalizedMode === "on";
      await context.store.saveState(state);
      console.log(`Auto-switch is now ${state.autoSwitch ? "enabled" : "disabled"}.`);
    });

  program
    .command("add")
    .description("Add a new alias using codex login or capture the active auth cache")
    .argument("<alias>", "Alias to register")
    .option("--device-auth", "Use codex login --device-auth")
    .option("--from-active", "Capture the current ~/.codex/auth.json without logging in again")
    .option("--priority <number>", "Priority for failover ordering", Number.parseInt)
    .option("--notes <text>", "Optional notes for the alias")
    .action(
      async (
        alias: string,
        options: { deviceAuth?: boolean; fromActive?: boolean; priority?: number; notes?: string },
      ) => {
        const normalizedAlias = normalizeAlias(alias);
        let sourcePath = context.store.env.codexAuthPath;
        let tempHome: string | undefined;
        try {
          if (!options.fromActive) {
            tempHome = context.store.tempLoginHome(normalizedAlias);
            await mkdir(tempHome, { recursive: true });
            await runCodexLogin(tempHome, Boolean(options.deviceAuth));
            sourcePath = path.join(tempHome, "auth.json");
          }

          const snapshot = await captureSnapshot(sourcePath, options.fromActive ? "active-auth" : "login-flow");
          const input: { priority?: number; notes?: string } = {};
          if (Number.isFinite(options.priority)) {
            input.priority = options.priority;
          }
          if (options.notes) {
            input.notes = options.notes;
          }
          const meta = await context.store.upsertAccount(normalizedAlias, snapshot, input);

          const state = await context.store.getState();
          if (!state.activeAlias && options.fromActive) {
            state.activeAlias = meta.alias;
            await context.store.saveState(state);
          }

          console.log(`Registered alias ${meta.alias} (${meta.authMode}, ${meta.fingerprint}).`);
        } finally {
          if (tempHome) {
            await rm(tempHome, { recursive: true, force: true });
          }
        }
      },
    );

  program
    .command("switch")
    .description("Switch the active Codex auth cache to a registered alias")
    .argument("<alias>", "Alias to activate")
    .action(async (alias: string) => {
      const normalizedAlias = normalizeAlias(alias);
      await switchActiveAlias(context.store, normalizedAlias, "manual");
      await refreshStatsForAlias(context.store, normalizedAlias);
      console.log(`Active Codex account switched to ${normalizedAlias}.`);
      console.log("New CLI processes use the switched account immediately. Codex app and IDE sessions may apply it on the next request or after a session reload.");
    });

  program
    .command("remove")
    .description("Remove a registered alias")
    .argument("<alias>", "Alias to remove")
    .option("--force", "Allow removal of the active alias")
    .action(async (alias: string, options: { force?: boolean }) => {
      const normalizedAlias = normalizeAlias(alias);
      const state = await context.store.getState();
      if (state.activeAlias === normalizedAlias && !options.force) {
        throw new Error("Refusing to remove the active alias without --force.");
      }

      await context.store.removeAccount(normalizedAlias);
      if (state.activeAlias === normalizedAlias) {
        state.activeAlias = undefined;
        await context.store.saveState(state);
      }

      console.log(`Removed alias ${normalizedAlias}.`);
    });

  program
    .command("rename")
    .description("Rename an existing alias")
    .argument("<currentAlias>", "Existing alias")
    .argument("<nextAlias>", "New alias")
    .action(async (currentAlias: string, nextAlias: string) => {
      await context.store.renameAccount(currentAlias, nextAlias);
      console.log(`Renamed ${normalizeAlias(currentAlias)} to ${normalizeAlias(nextAlias)}.`);
    });

  program
    .command("doctor")
    .description("Inspect managed auth readiness, plugin install state, and config health")
    .option("--json", "Emit JSON output")
    .action(async (options: { json?: boolean }) => {
      const result = await runDoctor(context.store);
      if (options.json) {
        printJson(result);
        return;
      }
      printTable(result.checks as unknown as Array<Record<string, unknown>>);
    });
}
