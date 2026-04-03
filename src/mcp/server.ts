import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeAlias, type AccountStore } from "../core/account-store.js";
import { getAccountInfoView, getStatusView, listAccountsWithFreshStats } from "../core/account-views.js";
import { captureSnapshot } from "../core/auth-snapshot.js";
import { runDoctor } from "../core/doctor.js";
import { reconcileHostFailover } from "../core/host-reconciliation.js";
import { refreshAllStats, refreshStatsForAlias } from "../core/stats-engine.js";
import { switchActiveAlias } from "../core/switch-engine.js";

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
      version: "0.3.0",
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
        description: "Enable or disable auto-switch mode.",
        inputSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
          },
          required: ["enabled"],
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
        await switchActiveAlias(store, alias, "manual");
        return textResult({
          ok: true,
          activeAlias: alias,
          note: "Codex app and IDE sessions may apply the switched account on the next request or after a session reload.",
        });
      }
      case "accounts.add": {
        const alias = normalizeAlias(String(args?.alias));
        const snapshot = await captureSnapshot(store.env.codexAuthPath, "active-auth");
        const input: { priority?: number; notes?: string } = {};
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
        state.autoSwitch = Boolean(args?.enabled);
        await store.saveState(state);
        return textResult(state);
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
