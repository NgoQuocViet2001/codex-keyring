# codex-accounts

`codex-accounts` is a native multi-account manager for Codex app, Codex CLI, and the Codex IDE extension.

It stays close to the official Codex experience:

- add accounts through the official `codex login` flow
- store account snapshots under simple aliases
- switch the active Codex auth cache atomically
- install a local plugin and MCP server for Codex app and IDE usage

For Vietnamese documentation, see [README.vi.md](./README.vi.md).

## Installation

```bash
npm install -g codex-accounts
codex-accounts install
codex-accounts doctor
```

`codex-accounts install` sets up managed mode, installs the local plugin payload for Codex, and updates the personal plugin marketplace.

### After `install`

After installation, `Codex Accounts` is available as a plugin inside Codex app and the Codex IDE extension.

You can ask a Codex agent to inspect accounts, switch aliases, rename aliases, run `doctor`, or guide the next step for you through natural-language requests.

When auto-switch is enabled, `Codex Accounts` also does best-effort reconciliation from recent Codex host failures so the next request or reopened session can move away from a limited alias.

## Quick Start

```bash
codex-accounts add account1 --from-active
codex-accounts add account2

codex-accounts list
codex-accounts switch account2
codex-accounts status
```

`account1` and `account2` are example aliases. Replace them with names that match the accounts you want to manage, such as `alice-work`, `alice-personal`, or `ngoquocviet2001`.

This captures the current Codex login as `account1`, signs into another account as `account2`, then lets you inspect and switch between them.

## Use In Codex App And IDE

After `codex-accounts install`:

1. restart Codex app or reload the IDE extension session
2. confirm `Codex Accounts` appears in the Plugins panel
3. use natural-language prompts to trigger account tools

Example prompts:

- `List all managed Codex accounts and show which alias is active.`
- `Switch the active Codex account to account2 for subsequent requests.`
- `Show the details for account2, including email, organization, and plan details when available.`
- `Rename the alias account2 to alice-work.`
- `Run a doctor check for codex-accounts and summarize the result.`

Account switches update the underlying Codex auth cache. New CLI processes pick up the switched account immediately. Codex app and IDE sessions may apply the switched account on the next request or after a session reload.

## Common Workflows

### Add the Current Login

```bash
codex-accounts add account1 --from-active
```

### Add Another Account

```bash
codex-accounts add account2
```

This uses the default browser-based `codex login` flow.

If you need device auth:

```bash
codex-accounts add account2 --device-auth
```

If your environment blocks device auth, log in first and then capture the active auth:

```bash
codex login
codex-accounts add account2 --from-active
```

### List and Inspect Accounts

```bash
codex-accounts list
codex-accounts info account2
codex-accounts status
codex-accounts stats
codex-accounts stats account2
```

### Switch Accounts

```bash
codex-accounts switch account2
codex-accounts switch account1
```

### Enable Auto-Switch

```bash
codex-accounts auto on
codex-accounts exec codex -- --help
```

`auto-switch` switches the active auth cache and retries a fresh process exactly once in `codex-accounts exec`.

For Codex app and the IDE extension, `codex-accounts` also reconciles recent host-side quota, rate-limit, auth-expiry, and workspace-mismatch signals so the next request or reopened session can pick up another alias. In-flight requests still do not continue seamlessly after the failure that already happened.

### Rename or Remove an Alias

```bash
codex-accounts rename account2 alice-work
codex-accounts remove alice-work
```

Removing the active alias requires `--force`.

## Supported Platforms

`codex-accounts` targets the same operating-system surface as the official Codex CLI:

- Windows
- macOS
- Linux
- WSL
- containerized environments where the official Codex CLI is supported and the user home directory is writable

## Command Reference

| Command | Purpose | Notes |
| --- | --- | --- |
| `codex-accounts list` | list aliases and health | supports `--json` |
| `codex-accounts status` | show active alias and managed mode | supports `--json` |
| `codex-accounts info <alias>` | show safe details for one alias | includes email, organization, and plan details when available |
| `codex-accounts stats [alias]` | show stats for one or all aliases | supports `--json` |
| `codex-accounts add <alias>` | add an alias through official login | browser OAuth by default |
| `codex-accounts add <alias> --device-auth` | add an alias through official device auth | may be blocked by org policy |
| `codex-accounts add <alias> --from-active` | capture the current active auth | no new login |
| `codex-accounts switch <alias>` | make an alias active | atomic and backup-aware |
| `codex-accounts remove <alias>` | remove an alias | active alias requires `--force` |
| `codex-accounts rename <old> <new>` | rename an alias | preserves snapshot |
| `codex-accounts auto on\|off` | enable or disable auto-switch | off by default |
| `codex-accounts exec -- <command>` | run a command with failover support | retries once after a supported switch |
| `codex-accounts install` | install the plugin and enable managed mode | supports `--no-manage-auth` |
| `codex-accounts uninstall` | remove the plugin from the marketplace | store data remains |
| `codex-accounts doctor` | inspect environment health | recommended after install |
| `codex-accounts mcp` | run the stdio MCP server | advanced integration use |

## Troubleshooting

### `doctor` shows `cli-auth-store` as `warn`

```bash
codex-accounts install
codex-accounts doctor
```

### Browser Login Works but Device Auth Fails

Some organizations block device auth. Use:

```bash
codex-accounts add account2
```

or:

```bash
codex login
codex-accounts add account2 --from-active
```

### The Plugin Does Not Appear

Run `codex-accounts doctor`, confirm the marketplace check passes, then restart Codex app or reload the IDE extension session.

### `info` Does Not Show the Business Workspace Name

`codex-accounts` only shows identity fields exposed by the official local Codex auth cache. On some business-managed accounts, the selected workspace title in the Codex UI is not present in the local auth snapshot, so `info` may only show email and plan details.

### `exec` Did Not Switch Accounts

Make sure auto-switch is enabled, another alias is available, and the failure matches a supported category such as quota, rate limit, auth expiry, or workspace mismatch.

For Codex app and IDE usage, the switch is best-effort for the next request or reopened session after the host logs a supported failure. It does not rescue the request that already failed.

## License

[MIT](./LICENSE)
