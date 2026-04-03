import { spawn } from "node:child_process";
import { Command } from "commander";
import { classifyFailure, pickNextAlias, shouldAutoSwitch } from "../../core/failover-engine.js";
import { refreshAllStats, refreshStatsForAlias } from "../../core/stats-engine.js";
import { switchActiveAlias } from "../../core/switch-engine.js";
import { createCodexInvocation } from "../../platform/codex-home.js";
import type { CliContext } from "../context.js";

async function runCommandWithCapture(command: string, args: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const invocation = command === "codex" ? createCodexInvocation(args) : { command, args };
    const child = spawn(invocation.command, invocation.args, {
      env: process.env,
      shell: invocation.shell,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("exit", (code: number | null) => {
      resolve({
        exitCode: code ?? 1,
        output,
      });
    });
  });
}

export function registerExecCommand(program: Command, context: CliContext): void {
  program
    .command("exec")
    .description("Run a command and retry once if managed auto-switch detects a supported auth/quota failure")
    .allowUnknownOption()
    .argument("<command>", "Command to run")
    .argument("[args...]", "Arguments passed to the command")
    .action(async (command: string, args: string[]) => {
      const state = await context.store.getState();
      const firstRun = await runCommandWithCapture(command, args ?? []);
      const failureReason = classifyFailure(firstRun.output);

      if (firstRun.exitCode === 0) {
        await context.store.appendEvent({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          type: "exec-success",
          alias: state.activeAlias,
          details: {
            command,
          },
        });
        if (state.activeAlias) {
          await refreshStatsForAlias(context.store, state.activeAlias);
        }
        process.exitCode = 0;
        return;
      }

      await context.store.appendEvent({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: failureReason && shouldAutoSwitch(failureReason) ? "limit-hit" : "exec-failure",
        alias: state.activeAlias,
        reason: failureReason,
        details: {
          command,
          exitCode: firstRun.exitCode,
        },
      });

      if (!state.autoSwitch || !shouldAutoSwitch(failureReason)) {
        process.exitCode = firstRun.exitCode;
        return;
      }

      const records = await context.store.listAccounts();
      await refreshAllStats(context.store);
      const nextAlias = pickNextAlias(state.activeAlias, records);
      if (!nextAlias) {
        process.exitCode = firstRun.exitCode;
        return;
      }

      await switchActiveAlias(context.store, nextAlias, failureReason);
      await refreshStatsForAlias(context.store, nextAlias);
      console.error(`codex-accounts: switched to ${nextAlias} after ${failureReason}; retrying once.`);

      const secondRun = await runCommandWithCapture(command, args ?? []);
      await context.store.appendEvent({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: secondRun.exitCode === 0 ? "exec-success" : "exec-failure",
        alias: nextAlias,
        details: {
          command,
          retried: true,
          exitCode: secondRun.exitCode,
        },
      });

      process.exitCode = secondRun.exitCode;
    });
}
