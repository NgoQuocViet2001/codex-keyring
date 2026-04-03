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
import type { AutoSwitchMode } from "../../core/types.js";
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

function formatRemainingPercent(value?: number): string {
  return Number.isFinite(value) ? `${value}%` : "--";
}

function assertAutoSwitchMode(value: string): AutoSwitchMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "balanced" || normalized === "sequential") {
    return normalized;
  }

  throw new Error("Auto-switch mode must be `off`, `balanced`, or `sequential`.");
}

function formatSwitchingMode(manualOnly: boolean): string {
  return manualOnly ? "manual-only" : "auto";
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
      const showSwitching = records.some((record) => record.manualOnly);

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
          row.health = record.health;
          if (showSwitching) {
            row.switching = formatSwitchingMode(record.manualOnly);
          }
          row["5h left"] = formatRemainingPercent(record.limit5hRemainingPercent);
          row["week left"] = formatRemainingPercent(record.limitWeekRemainingPercent);
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
      console.log(`Auto-switch  : ${payload.state.autoSwitchMode}`);
      console.log(`Managed mode : ${payload.state.managedAuthMode ? "on" : "off"}`);
      const showSwitching = payload.aliases.some((alias) => alias.manualOnly);
      printTable(
        payload.aliases.map((alias) => ({
          alias: alias.alias,
          email: alias.email ?? "",
          planType: alias.planType ?? "",
          active: alias.active,
          health: alias.health,
          ...(showSwitching ? { switching: formatSwitchingMode(alias.manualOnly) } : {}),
          "5h left": formatRemainingPercent(alias.limit5hRemainingPercent),
          "week left": formatRemainingPercent(alias.limitWeekRemainingPercent),
        })) as Array<Record<string, unknown>>,
      );
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
        printInfo({
          alias: stats.alias,
          health: stats.health,
          confidence: stats.confidence,
          quotaObservedAt: stats.quotaObservedAt,
          "5h left": formatRemainingPercent(stats.limit5hRemainingPercent),
          limit5hResetAt: stats.limit5hResetAt,
          "week left": formatRemainingPercent(stats.limitWeekRemainingPercent),
          limitWeekResetAt: stats.limitWeekResetAt,
          lastLimitHitAt: stats.lastLimitHitAt,
          cooldownUntil: stats.cooldownUntil,
          notes: stats.notes,
        });
        return;
      }

      const stats = await refreshAllStats(context.store);
      if (options.json) {
        printJson(stats);
        return;
      }
      printTable(
        stats.map((record) => ({
          alias: record.alias,
          health: record.health,
          confidence: record.confidence,
          "5h left": formatRemainingPercent(record.limit5hRemainingPercent),
          "week left": formatRemainingPercent(record.limitWeekRemainingPercent),
          cooldownUntil: record.cooldownUntil ?? "",
          lastLimitHitAt: record.lastLimitHitAt ?? "",
        })) as Array<Record<string, unknown>>,
      );
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
      const printable = {
        ...payload,
        switching: formatSwitchingMode(payload.manualOnly),
      } as Record<string, unknown>;
      delete printable.manualOnly;
      printInfo(printable);
    });

  program
    .command("auto")
    .description("Set the global auto-switch mode")
    .argument("<mode>", "off, balanced, or sequential")
    .action(async (mode: string) => {
      const state = await context.store.getState();
      state.autoSwitchMode = assertAutoSwitchMode(mode);
      state.autoSwitch = state.autoSwitchMode !== "off";
      await context.store.saveState(state);
      console.log(`Auto-switch mode is now ${state.autoSwitchMode}.`);
    });

  program
    .command("auto-account")
    .description("Include or exclude one alias from auto-switch")
    .argument("<alias>", "Alias to update")
    .argument("<mode>", "on or off")
    .action(async (alias: string, mode: string) => {
      const normalizedAlias = normalizeAlias(alias);
      const normalizedMode = mode.trim().toLowerCase();
      if (normalizedMode !== "on" && normalizedMode !== "off") {
        throw new Error("Mode must be `on` or `off`.");
      }

      const meta = await context.store.setManualOnly(normalizedAlias, normalizedMode === "off");
      console.log(`${meta.alias} is now ${meta.manualOnly ? "manual-only" : "eligible"} for auto-switch.`);
    });

  program
    .command("add")
    .description("Add a new alias using codex login or capture the active auth cache")
    .argument("<alias>", "Alias to register")
    .option("--device-auth", "Use codex login --device-auth")
    .option("--from-active", "Capture the current ~/.codex/auth.json without logging in again")
    .option("--manual-only", "Register this alias for manual switching only")
    .option("--priority <number>", "Priority for failover ordering", Number.parseInt)
    .option("--notes <text>", "Optional notes for the alias")
    .action(
      async (
        alias: string,
        options: { deviceAuth?: boolean; fromActive?: boolean; manualOnly?: boolean; priority?: number; notes?: string },
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
          const input: { manualOnly?: boolean; priority?: number; notes?: string } = {};
          if (options.manualOnly) {
            input.manualOnly = true;
          }
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

          console.log(
            `Registered alias ${meta.alias} (${meta.authMode}, ${meta.fingerprint}${meta.manualOnly ? ", manual-only" : ""}).`,
          );
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
