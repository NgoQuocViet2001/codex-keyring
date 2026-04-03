import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { installPlugin, uninstallPlugin } from "../../platform/npm-installer.js";
import type { CliContext } from "../context.js";

export function registerInstallCommands(program: Command, context: CliContext): void {
  program
    .command("install")
    .description("Install the plugin into the personal Codex marketplace and enable managed mode")
    .option("--no-manage-auth", "Do not touch ~/.codex/config.toml")
    .option("--json", "Emit JSON output")
    .action(async (options: { manageAuth?: boolean; json?: boolean }) => {
      const result = await installPlugin(
        context.store,
        fileURLToPath(new URL("../../..", import.meta.url)),
        options.manageAuth !== false,
      );
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Plugin path       : ${result.pluginPath}`);
      console.log(`Marketplace path  : ${result.marketplacePath}`);
      console.log(`Managed auth mode : ${result.managedAuthChanged ? "updated" : "unchanged"}`);
    });

  program
    .command("uninstall")
    .description("Remove the plugin from the personal Codex marketplace")
    .action(async () => {
      await uninstallPlugin(context.store);
      console.log("Removed codex-accounts from the personal Codex marketplace.");
    });
}
