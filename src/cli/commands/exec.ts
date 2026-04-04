import { spawn } from "node:child_process";
import { Command } from "commander";
import { classifyFailure, pickNextAlias, shouldAutoSwitch } from "../../core/failover-engine.js";
import { extractQuotaSnapshotFromText } from "../../core/quota-snapshot.js";
import { refreshAllStats, refreshStatsForAlias } from "../../core/stats-engine.js";
import { switchActiveAlias } from "../../core/switch-engine.js";
import { createCodexInvocation } from "../../platform/codex-home.js";
import type { FailoverReason } from "../../core/types.js";
import type { CliContext } from "../context.js";

interface CapturedCommandResult {
  exitCode: number;
  output: string;
}

interface ManagedRunResult extends CapturedCommandResult {
  failureReason?: FailoverReason;
  liveSwitchedAliases: string[];
}

interface ExecParentTtyState {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}

const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir",
]);

const CODEX_NON_INTERACTIVE_SUBCOMMANDS = new Set(["exec", "review"]);

function firstCodexPositionalArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token === "--") {
      return args[index + 1];
    }
    if (CODEX_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token;
  }

  return undefined;
}

export function shouldPreserveInteractiveCodexTty(
  command: string,
  args: string[],
  ttyState: ExecParentTtyState = {
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  },
): boolean {
  if (command !== "codex") {
    return false;
  }
  if (!ttyState.stdinIsTTY || !ttyState.stdoutIsTTY || !ttyState.stderrIsTTY) {
    return false;
  }

  const positional = firstCodexPositionalArg(args);
  return positional ? !CODEX_NON_INTERACTIVE_SUBCOMMANDS.has(positional) : true;
}

async function runCommandWithCapture(
  command: string,
  args: string[],
  options: {
    onOutputChunk?: (text: string) => void;
  } = {},
): Promise<CapturedCommandResult> {
  return new Promise((resolve, reject) => {
    const invocation = command === "codex" ? createCodexInvocation(args) : { command, args };
    const preserveInteractiveTty = shouldPreserveInteractiveCodexTty(command, args);
    const child = spawn(invocation.command, invocation.args, {
      env: process.env,
      shell: invocation.shell,
      stdio: preserveInteractiveTty ? "inherit" : ["inherit", "pipe", "pipe"],
    });

    let output = "";
    if (preserveInteractiveTty) {
      child.on("error", reject);
      child.on("exit", (code: number | null) => {
        resolve({
          exitCode: code ?? 1,
          output,
        });
      });
      return;
    }

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      reject(new Error("Expected piped stdout/stderr for captured command execution."));
      return;
    }

    stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      options.onOutputChunk?.(text);
    });
    stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
      options.onOutputChunk?.(text);
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

async function attemptAutoSwitch(
  context: CliContext,
  reason: FailoverReason,
  skippedAliases: Set<string> = new Set(),
): Promise<{ fromAlias: string; nextAlias: string } | undefined> {
  const state = await context.store.getState();
  if (!state.autoSwitch || !state.activeAlias || !shouldAutoSwitch(reason) || skippedAliases.has(state.activeAlias)) {
    return undefined;
  }

  await refreshAllStats(context.store);
  const records = await context.store.listAccounts();
  const nextAlias = pickNextAlias(state.activeAlias, records, {
    mode: state.autoSwitchMode,
    reason,
  });
  if (!nextAlias) {
    return undefined;
  }

  await switchActiveAlias(context.store, nextAlias, reason);
  await refreshStatsForAlias(context.store, nextAlias);
  return {
    fromAlias: state.activeAlias,
    nextAlias,
  };
}

async function runManagedCommand(command: string, args: string[], context: CliContext): Promise<ManagedRunResult> {
  let observedReason: FailoverReason | undefined;
  const liveSwitchedAliases: string[] = [];
  const switchedFromAliases = new Set<string>();
  let switchPromise: Promise<void> | undefined;
  let lastSwitchStartedAt = 0;

  const result = await runCommandWithCapture(command, args, {
    onOutputChunk: (text: string) => {
      const reason = classifyFailure(text);
      if (!reason) {
        return;
      }

      observedReason = reason;
      if (!shouldAutoSwitch(reason)) {
        return;
      }

      const now = Date.now();
      if (switchPromise || now - lastSwitchStartedAt < 1_500) {
        return;
      }

      lastSwitchStartedAt = now;
      switchPromise = (async () => {
        const switched = await attemptAutoSwitch(context, reason, switchedFromAliases);
        if (switched) {
          switchedFromAliases.add(switched.fromAlias);
          liveSwitchedAliases.push(switched.nextAlias);
          console.error(
            `codex-keyring: switched to ${switched.nextAlias} after ${reason}; the next prompt should use the new account.`,
          );
        }
      })().finally(() => {
        switchPromise = undefined;
      });
    },
  });

  if (switchPromise) {
    await switchPromise;
  }

  return {
    ...result,
    failureReason: observedReason ?? classifyFailure(result.output),
    liveSwitchedAliases,
  };
}

export function registerExecCommand(program: Command, context: CliContext): void {
  program
    .command("exec")
    .description("Run a command and retry once if managed auto-switch detects a supported auth/quota failure")
    .allowUnknownOption()
    .argument("<command>", "Command to run")
    .argument("[args...]", "Arguments passed to the command")
    .action(async (command: string, args: string[]) => {
      const initialState = await context.store.getState();
      const firstRun = await runManagedCommand(command, args ?? [], context);
      const firstRunQuota = extractQuotaSnapshotFromText(firstRun.output, new Date().toISOString(), "exec-output");

      if (firstRun.exitCode === 0) {
        const successState = await context.store.getState();
        await context.store.appendEvent({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          type: "exec-success",
          alias: successState.activeAlias ?? initialState.activeAlias,
          details: {
            command,
            liveSwitchedAliases: firstRun.liveSwitchedAliases,
            quotaSnapshot: firstRunQuota,
          },
        });
        if (successState.activeAlias) {
          await refreshStatsForAlias(context.store, successState.activeAlias);
        }
        process.exitCode = 0;
        return;
      }

      const failureState = await context.store.getState();
      await context.store.appendEvent({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: firstRun.failureReason && shouldAutoSwitch(firstRun.failureReason) ? "limit-hit" : "exec-failure",
        alias: failureState.activeAlias ?? initialState.activeAlias,
        reason: firstRun.failureReason,
        details: {
          command,
          exitCode: firstRun.exitCode,
          liveSwitchedAliases: firstRun.liveSwitchedAliases,
          quotaSnapshot: firstRunQuota,
        },
      });

      const failureReason = firstRun.failureReason;
      if (!failureState.autoSwitch || !failureReason || !shouldAutoSwitch(failureReason)) {
        process.exitCode = firstRun.exitCode;
        return;
      }

      let retryAlias = firstRun.liveSwitchedAliases.at(-1);
      if (!retryAlias) {
        const switched = await attemptAutoSwitch(context, failureReason);
        retryAlias = switched?.nextAlias;
        if (retryAlias) {
          console.error(`codex-keyring: switched to ${retryAlias} after ${failureReason}; retrying once.`);
        }
      } else {
        console.error(`codex-keyring: retrying once with ${retryAlias}.`);
      }

      if (!retryAlias) {
        process.exitCode = firstRun.exitCode;
        return;
      }

      const secondRun = await runManagedCommand(command, args ?? [], context);
      const secondRunQuota = extractQuotaSnapshotFromText(secondRun.output, new Date().toISOString(), "exec-output");

      await context.store.appendEvent({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: secondRun.exitCode === 0 ? "exec-success" : "exec-failure",
        alias: retryAlias,
        reason: secondRun.failureReason,
        details: {
          command,
          retried: true,
          exitCode: secondRun.exitCode,
          liveSwitchedAliases: secondRun.liveSwitchedAliases,
          quotaSnapshot: secondRunQuota,
        },
      });

      const finalState = await context.store.getState();
      if (finalState.activeAlias) {
        await refreshStatsForAlias(context.store, finalState.activeAlias);
      }

      process.exitCode = secondRun.exitCode;
    });
}
