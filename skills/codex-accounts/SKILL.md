---
name: codex-accounts
description: Manage multiple Codex logins with aliases, safe switching, installer automation, and account health checks through the local codex-accounts MCP tools.
---

# Codex Accounts

Use this skill when the user wants to list, add, switch, remove, rename, or inspect Codex accounts managed by the `codex-accounts` extension.

## Core Rules

- Prefer the `accounts.*` MCP tools exposed by this plugin.
- Treat raw auth files, tokens, API keys, and refresh credentials as secrets. Never print them.
- Use aliases in user-facing responses. Only mention fingerprints or file paths when debugging.
- Respect the native Codex approach: `codex login` for sign-in, file-backed cache for managed multi-account, no proxy routing.

## Typical Flows

1. `accounts.list`
   - Show aliases, active alias, auth mode, and health summary.
2. `accounts.add`
   - Add a new alias using the official `codex login` flow or capture the current active auth.
3. `accounts.switch`
   - Move the active account to the requested alias with safe auth replacement.
4. `accounts.set_auto_mode`
   - Enable or disable supported auto-switch.
5. `accounts.stats`
   - Show per-alias health and limit-confidence data.
6. `accounts.doctor`
   - Diagnose config, marketplace installation, and managed auth readiness.

## Response Style

- Keep operational instructions concise and concrete.
- Call out if a result is `exact`, `estimated`, or `manual`.
- If managed mode is not ready, explain the blocker and the next command to run.
