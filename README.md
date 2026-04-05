# codex-keyring

`codex-keyring` is a native multi-account manager for Codex app, Codex CLI, and the Codex IDE extension.

It is built for people who want to keep multiple Codex logins under clean aliases, switch manually in one command, or let Codex fail over automatically after supported quota, rate-limit, auth-expiry, and workspace-mismatch failures.

It stays close to the official Codex experience:

- add accounts through the official `codex login` flow
- store account snapshots under simple aliases
- switch the active Codex auth cache atomically
- surface the most useful quota signals, especially 5-hour and weekly remaining limits
- enable auto-switch with `off`, `balanced`, and `sequential` quota-aware modes
- install a local plugin and MCP server for Codex app and IDE usage

For Vietnamese documentation, see [README.vi.md](./README.vi.md).

## Installation

```bash
npm install -g codex-keyring
codex-keyring install
codex-keyring doctor
```

`codex-keyring install` sets up managed mode, installs the local plugin payload for Codex, and updates the personal plugin marketplace.

### After `install`

After installation, `Codex Keyring` is available as a plugin inside Codex app and the Codex IDE extension.

You can ask a Codex agent to inspect accounts, switch aliases, rename aliases, run `doctor`, or guide the next step for you through natural-language requests.

When auto-switch is enabled, `Codex Keyring` also does best-effort reconciliation from recent Codex host quota signals so the next request or reopened session can move away from a limited alias.

## Quick Start For Multi-Account Switching

```bash
codex-keyring add account1 --from-active
codex-keyring add account2

codex-keyring list
codex-keyring switch account2
codex-keyring status
```

`account1` and `account2` are example aliases. Replace them with names that match the accounts you want to manage, such as `alice-work`, `alice-personal`, or `ngoquocviet2001`.

This captures the current Codex login as `account1`, signs into another account as `account2`, then lets you inspect accounts, switch manually, or prepare for quota-aware auto-switch failover. The default CLI view now highlights `5h left` and `week left` when Codex has exposed exact local quota data, including live session-log recovery for the active alias when the host SQLite log is missing or unreadable.

## Update Tip

When a newer npm release is available, interactive `codex-keyring` commands show a lightweight prompt so you can choose `Update now` or `Skip this version`.

Machine-readable flows such as `--json`, `--help`, `--version`, and `codex-keyring mcp` stay quiet so scripts and MCP stdio are not polluted.

## Use In Codex App And IDE

After `codex-keyring install`:

1. restart Codex app or reload the IDE extension session
2. confirm `Codex Keyring` appears in the Plugins panel
3. use natural-language prompts to trigger account tools

Example prompts:

- `List all managed Codex accounts and show which alias is active.`
- `Switch the active Codex account to account2 for subsequent requests.`
- `Show the details for account2, including email, organization, and plan details when available.`
- `Rename the alias account2 to alice-work.`
- `Run a doctor check for codex-keyring and summarize the result.`

Account switches update the underlying Codex auth cache. New CLI processes pick up the switched account immediately. Codex app and IDE sessions may apply the switched account on the next request or after a session reload.

## Common Workflows

### Add the Current Login

```bash
codex-keyring add account1 --from-active
```

### Add Another Account

```bash
codex-keyring add account2
```

This uses the default browser-based `codex login` flow.

If you need device auth:

```bash
codex-keyring add account2 --device-auth
```

If your environment blocks device auth, log in first and then capture the active auth:

```bash
codex login
codex-keyring add account2 --from-active
```

### List and Inspect Accounts

```bash
codex-keyring list
codex-keyring info account2
codex-keyring status
codex-keyring stats
codex-keyring stats account2
```

If a 5-hour or weekly quota window has already crossed its `resetAt` time but Codex has not emitted a newer host signal yet, `codex-keyring` now shows `--` for that window instead of reusing stale remaining quota as if it were still exact. Check the `confidence` column or `codex-keyring stats <alias>` when you want the freshest explanation.

### Switch Accounts Manually

```bash
codex-keyring switch account2
codex-keyring switch account1
```

### Enable Auto-Switch Failover

```bash
codex-keyring auto sequential
codex-keyring exec codex -- --help
```

There are three auto-switch modes:

- `off` disables automatic switching completely.
- `balanced` is the smart mode. It scores both 5-hour and weekly remaining quota, but for the 5-hour window it now rebalances only when the active alias drops to roughly `20%` or lower. Weekly reserve is still considered when it gets critically low.
- `sequential` keeps the current alias until it is effectively blocked, then moves to the best alias still known to have quota.

If you want the most predictable day-to-day behavior, start with `sequential`. It is the recommended mode for most users.

`codex-keyring exec` can now switch the active auth cache as soon as a live CLI session emits a supported quota or auth failure. If the process still exits, it retries one fresh process exactly once after the failover.

For Codex app and the IDE extension, `codex-keyring` also reconciles recent host-side quota, rate-limit, auth-expiry, and workspace-mismatch signals so the next request or reopened session can pick up another alias. In `balanced` mode, that reconciliation can now proactively rebalance when exact live quota shows the active alias has already fallen past the rebalance threshold. In-flight requests still do not continue seamlessly after the failure that already happened.

### Keep One Alias Manual-Only

```bash
codex-keyring add account3 --manual-only
codex-keyring auto-account account3 off
```

Use this when an alias should remain available for manual switching but must never be chosen automatically.

If you manually switch to a `manual-only` alias, `codex-keyring` now turns global auto-switch `off` immediately. When you later move back to an auto-enabled alias, run `codex-keyring auto sequential` or `codex-keyring auto balanced` to re-enable auto-switch.

### Rename or Remove an Alias

```bash
codex-keyring rename account2 alice-work
codex-keyring remove alice-work
```

Removing the active alias requires `--force`.

## Supported Platforms

`codex-keyring` targets the same operating-system surface as the official Codex CLI:

- Windows
- macOS
- Linux
- WSL
- containerized environments where the official Codex CLI is supported and the user home directory is writable

## Command Reference

| Command | Purpose | Notes |
| --- | --- | --- |
| `codex-keyring list` | list aliases and health | default table highlights `confidence`, `5h left`, and `week left`; supports `--json` |
| `codex-keyring status` | show active alias and managed mode | includes auto-switch mode plus `confidence` and quota summary; supports `--json` |
| `codex-keyring info <alias>` | show safe details for one alias | includes email, organization, and plan details when available |
| `codex-keyring stats [alias]` | show quota-aware stats for one or all aliases | includes 5-hour and weekly quota when known; supports `--json` |
| `codex-keyring add <alias>` | add an alias through official login | browser OAuth by default |
| `codex-keyring add <alias> --manual-only` | add an alias that never participates in auto-switch | still available for manual `switch` |
| `codex-keyring add <alias> --device-auth` | add an alias through official device auth | may be blocked by org policy |
| `codex-keyring add <alias> --from-active` | capture the current active auth | no new login |
| `codex-keyring switch <alias>` | make an alias active | atomic and backup-aware |
| `codex-keyring remove <alias>` | remove an alias | active alias requires `--force` |
| `codex-keyring rename <old> <new>` | rename an alias | preserves snapshot |
| `codex-keyring auto off\|balanced\|sequential` | set the global auto-switch mode | `sequential` is the recommended starting mode |
| `codex-keyring auto-account <alias> on\|off` | include or exclude one alias from auto-switch | `off` means manual-only |
| `codex-keyring exec -- <command>` | run a command with failover support | retries once after a supported switch |
| `codex-keyring install` | install the plugin and enable managed mode | supports `--no-manage-auth` |
| `codex-keyring uninstall` | remove the plugin from the marketplace | store data remains |
| `codex-keyring doctor` | inspect environment health | recommended after install |
| `codex-keyring mcp` | run the stdio MCP server | advanced integration use |

## Troubleshooting

### `doctor` shows `cli-auth-store` as `warn`

```bash
codex-keyring install
codex-keyring doctor
```

### Browser Login Works but Device Auth Fails

Some organizations block device auth. Use:

```bash
codex-keyring add account2
```

or:

```bash
codex login
codex-keyring add account2 --from-active
```

### The Plugin Does Not Appear

Run `codex-keyring doctor`, confirm the marketplace check passes, then restart Codex app or reload the IDE extension session.

### `5h left` or `week left` Shows `--`

This usually means the last exact quota snapshot has already passed its `resetAt` boundary and Codex has not emitted a fresher host-side signal yet. `codex-keyring` now prefers hiding stale quota rather than showing an old `0%` or old remaining value as if it were still exact.

Run `codex-keyring stats <alias>` to inspect the latest observation time and note text. The `confidence` column in `list` and `status` also tells you whether the remaining quota is exact, estimated, or manual.

### A Newly Added Account Does Not Show the Same Codex UI Settings

`codex-keyring` only switches the official local auth cache. Account-specific Codex cloud preferences such as language, UI experiments, or missing server-side settings are not stored inside `auth.json`, so they cannot be copied from one account to another.

### `info` Does Not Show the Business Workspace Name

`codex-keyring` only shows identity fields exposed by the official local Codex auth cache. On some business-managed accounts, the selected workspace title in the Codex UI is not present in the local auth snapshot, so `info` may only show email and plan details.

### `exec` Did Not Switch Accounts

Make sure auto-switch is enabled, another alias is available, and the failure matches a supported category such as quota, rate limit, auth expiry, or workspace mismatch.

For Codex app and IDE usage, the switch is best-effort for the next request or reopened session after the host logs a supported failure. It does not rescue the request that already failed.

### What `uninstall` Leaves Behind

`codex-keyring uninstall` removes the plugin and marketplace entry, but it leaves the current `~/.codex/auth.json` in place. In practice, whichever alias was active at uninstall time remains the active Codex login afterward.

## License

[MIT](./LICENSE)
