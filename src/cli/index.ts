#!/usr/bin/env node
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { startMcpServer } from "../mcp/server.js";
import { registerAccountCommands } from "./commands/accounts.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerInstallCommands } from "./commands/install.js";
import { createCliContext } from "./context.js";

async function main(): Promise<void> {
  const context = await createCliContext();
  const program = new Command();
  program.name("codex-keyring").description("Native multi-account manager for Codex").version(packageJson.version);

  registerAccountCommands(program, context);
  registerInstallCommands(program, context);
  registerExecCommand(program, context);

  program
    .command("mcp")
    .description("Start the internal stdio MCP server")
    .action(async () => {
      await startMcpServer(context.store);
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codex-keyring: ${message}`);
  process.exitCode = 1;
});
