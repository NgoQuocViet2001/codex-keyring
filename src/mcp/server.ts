import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeAlias, type AccountStore } from "../core/account-store.js";
import { getAccountInfoView, getStatusView, listAccountsWithFreshStats } from "../core/account-views.js";
import { captureSnapshot } from "../core/auth-snapshot.js";
import { runDoctor } from "../core/doctor.js";
import { reconcileHostFailover } from "../core/host-reconciliation.js";
import { refreshAllStats, refreshStatsForAlias } from "../core/stats-engine.js";
import { disableAutoSwitchForActiveManualOnlyAlias, switchActiveAlias } from "../core/switch-engine.js";

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export async function startMcpServer(store: AccountStore): Promise<void> {
  try {
    await reconcileHostFailover(store);
  } catch {
    // Host-log reconciliation is best-effort and must not block MCP startup.
  }

  const server = new Server(
    {
      name: "codex-keyring",
      version: "0.5.3",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "accounts.list",
        description: "List all managed Codex aliases and the active alias.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "accounts.switch",
        description: "Switch the active Codex account to a specific alias for subsequent requests.",
        inputSchema: {
          type: "object",
          properties: {
            alias: { type: "string" },
          },
          required: ["alias"],
          additionalProperties: false,
        },
      },
      {
        name: "accounts.add",
        description: "Register a new alias from the active auth cache.",
        inputSchema: {
          type: "object",
          properties: {
            alias: { type: "string" },
            manualOnly: { type: "boolean" },
            priority: { type: "number" },
            notes: { type: "string" },
          },
          required: ["alias"],
          additionalProperties: false,
        },
      },
      {
        name: "accounts.remove",
        description: "Remove an alias.",
        inputSchema: {
          type: "object",
          properties: {
            alias: { type: "string" },
          },
          required: ["alias"],
          additionalProperties: false,
        },
      },
      {
        name: "accounts.rename",
        description: "Rename an alias.",
        inputSchema: {
          type: "object",
          properties: {
            currentAlias: { type: "string" },
            nextAlias: { type: "string" },
          },
          required: ["currentAlias", "nextAlias"],
          additionalProperties: false,
        },
      },
      {
        name: "accounts.set_auto_mode",
        description: "Set the global auto-switch mode.",
        inputSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            mode: {
              type: "string",
              enum: ["off", "balanced", "sequential"],
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "accounts.set_auto_participation",
        description: "Include or exclude one alias from auto-switch.",
        inputSchema: {
          type: "object",
          properties: {
            alias: { type: "string" },
            enabled: { type: "boolean" },
          },
          required: ["alias", "enabled"],
          additionalProperties: false,
        },
      },
      {
        name: "accounts.status",
        description: "Show active alias and managed mode state.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "accounts.stats",
        description: "Show stats for one alias or all aliases.",
        inputSchema: {
          type: "object",
          properties: {
            alias: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "accounts.info",
        description: "Show safe details for one alias, including email, organization, and plan details when available.",
        inputSchema: {
          type: "object",
          properties: {
            alias: { type: "string" },
          },
          required: ["alias"],
          additionalProperties: false,
        },
      },
      {
        name: "accounts.doctor",
        description: "Inspect configuration and installation health.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      await reconcileHostFailover(store);
    } catch {
      // Host-log reconciliation is best-effort and must not block tool calls.
    }

    const { name, arguments: args } = request.params;
    switch (name) {
      case "accounts.list":
        return textResult(await listAccountsWithFreshStats(store));
      case "accounts.switch": {
        const alias = normalizeAlias(String(args?.alias));
        const result = await switchActiveAlias(store, alias, "manual");
        return textResult({
          ok: true,
          activeAlias: alias,
          autoSwitchDisabled: result.autoSwitchDisabled ?? false,
          note: result.autoSwitchDisabled
            ? "Auto-switch was turned off because this alias is manual-only. Switch to an auto-enabled alias later and enable auto-switch again when you want it back."
            : "Codex app and IDE sessions may apply the switched account on the next request or after a session reload.",
        });
      }
      case "accounts.add": {
        const alias = normalizeAlias(String(args?.alias));
        const snapshot = await captureSnapshot(store.env.codexAuthPath, "active-auth");
        const input: { manualOnly?: boolean; priority?: number; notes?: string } = {};
        if (typeof args?.manualOnly === "boolean") {
          input.manualOnly = args.manualOnly;
        }
        if (typeof args?.priority === "number") {
          input.priority = args.priority;
        }
        if (typeof args?.notes === "string") {
          input.notes = args.notes;
        }
        const meta = await store.upsertAccount(alias, snapshot, input);
        return textResult(meta);
      }
      case "accounts.remove":
        await store.removeAccount(String(args?.alias));
        return textResult({ ok: true });
      case "accounts.rename":
        await store.renameAccount(String(args?.currentAlias), String(args?.nextAlias));
        return textResult({ ok: true });
      case "accounts.set_auto_mode": {
        const state = await store.getState();
        if (args?.mode === "off" || args?.mode === "balanced" || args?.mode === "sequential") {
          state.autoSwitchMode = args.mode;
          state.autoSwitch = args.mode !== "off";
        } else if (typeof args?.enabled === "boolean") {
          state.autoSwitch = args.enabled;
          state.autoSwitchMode = args.enabled
            ? state.autoSwitchMode === "sequential"
              ? "sequential"
              : "balanced"
            : "off";
        }
        await store.saveState(state);
        return textResult(state);
      }
      case "accounts.set_auto_participation": {
        const alias = normalizeAlias(String(args?.alias));
        const meta = await store.setManualOnly(alias, !Boolean(args?.enabled));
        const autoSwitchDisabled = meta.manualOnly ? await disableAutoSwitchForActiveManualOnlyAlias(store, alias) : false;
        return textResult({
          ...meta,
          autoSwitchDisabled,
          note: autoSwitchDisabled
            ? "Auto-switch was turned off because the active alias is now manual-only."
            : undefined,
        });
      }
      case "accounts.status":
        return textResult(await getStatusView(store));
      case "accounts.stats":
        if (typeof args?.alias === "string") {
          return textResult(await refreshStatsForAlias(store, normalizeAlias(args.alias)));
        }
        return textResult(await refreshAllStats(store));
      case "accounts.info":
        return textResult(await getAccountInfoView(store, normalizeAlias(String(args?.alias))));
      case "accounts.doctor":
        return textResult(await runDoctor(store));
      default:
        throw new Error(`Unsupported tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
