# Changelog

## 0.6.1

- Keep exact 5-hour and weekly remaining quota fresh across manual account switches by reading `token_count` session events that happen after `lastSwitchAt`, even when the Codex session itself started earlier
- Re-enable the documented `balanced` startup rebalance behavior when exact live quota telemetry shows the active alias has dropped below the configured threshold, while still keeping `sequential` conservative
- Improve host-log alias attribution by refusing to pin explicit unknown emails onto the current active alias, preventing false limit-hit events and bad auto-switch decisions
- Add CLI UX for existing aliases so commands like `switch`, `info`, `stats`, `remove`, and `rename` can resolve a unique prefix or fail clearly with an ambiguity message instead of surfacing raw `ENOENT`

## 0.6.0

- Recover exact 5-hour and weekly headroom directly from live Codex session logs when the host SQLite log is missing or unreadable, so `status`, `list`, and `stats` stop showing stale `--` values for active sessions
- Prevent host-side quota and limit-hit rows from being attached to the wrong alias when the log includes an explicit email that does not map to a managed account, which keeps auto-switch decisions accurate after the app hits quota
- Keep startup reconciliation useful even when Codex host logs are unavailable by still refreshing stats and auto-switching away from a blocked active alias when fresh session quota data proves it is exhausted
- Add an interactive update notifier for newer npm releases, with `Update now` or `Skip this version`, while keeping `--json`, help/version flows, and `mcp` output quiet
- Refresh both English and Vietnamese READMEs to remove stale legacy naming and document the new update prompt behavior

## 0.5.5

- Classify OpenAI `insufficient quota` and `insufficient_quota` failures as `quota-exhausted` so supported auto-switch failover still triggers for that quota error family
- Keep the classifier narrow enough to avoid treating generic quota discussion text as a real failover signal

## 0.5.4

- Classify common Codex `403 Forbidden` workspace and organization policy failures as `workspace-mismatch` so supported failover can still trigger
- Add regression coverage for plain-text and JSON-shaped `403` failure payloads

## 0.5.3

- Republish the latest quota-aware switching and manual-only behavior with the refreshed English and Vietnamese guides so GitHub and npm stay aligned
- Keep release metadata in sync for the plugin manifest, MCP server version, and package manifest

## 0.5.2

- Turn global auto-switch `off` automatically when the active alias becomes `manual-only`, including after a manual `switch` or `auto-account <alias> off`
- Return a clearer notice in CLI and MCP responses so users know they must re-enable auto-switch manually after moving back to an auto-enabled alias

## 0.5.1

- Make `list`, `status`, `stats`, and `info` sync fresh Codex host quota signals before rendering, so recovered 5-hour and weekly headroom show up much closer to real time
- Reduce `balanced` proactive 5-hour rebalancing to a single practical threshold around `20%`, while still considering weekly reserve when it gets critically low
- Recover account health back to `ready` or `active` after a newer positive quota observation arrives, instead of leaving accounts stuck in degraded state after quota has already recovered
- Add a read-only host-log sync path so view commands refresh stats without causing a surprise auto-switch as a side effect

## 0.5.0

- Replace `codex-keyring auto on|off --mode ...` with a single `codex-keyring auto off|balanced|sequential` command
- Add per-alias manual-only participation so specific accounts can be excluded from auto-switch while remaining available for manual switching
- Make `balanced` auto-switch score both 5-hour and weekly remaining quota, instead of looking only at short-window headroom
- Keep startup behavior steadier by avoiding proactive rebalance during passive host-log reconciliation unless the active alias has actually hit a supported failure or is already blocked
- Clarify that uninstall leaves the currently active auth cache in place, so the account that was active stays active after the plugin is removed

## 0.4.0

- Add exact quota parsing from Codex host `codex.rate_limits` signals and `usage_limit_reached` headers, including 5-hour and weekly remaining percentages plus reset timestamps
- Add `balanced` and `sequential` auto-switch modes, with `balanced` as the default strategy for spreading 5-hour quota before accounts hit the wall
- Improve `codex-keyring exec` so live CLI sessions can switch the active auth cache as soon as a supported limit signal appears, while still retrying one fresh process after failover when needed
- Simplify `list`, `status`, and `stats` output so the default view focuses on account health plus 5-hour and weekly quota instead of lower-signal columns
- Remove legacy `codex-accounts` plugin cache artifacts during install and uninstall to keep local Codex plugin state clean

## 0.3.0

- Rename the project from `codex-accounts` to `codex-keyring`, including the npm package, CLI command, plugin slug, guides, and legacy upgrade path for store and marketplace migration
- Add best-effort host-log reconciliation so Codex app and IDE sessions can rotate to another alias for the next request or reopened session after supported quota, rate-limit, auth-expiry, or workspace-mismatch failures
- Tighten failure classification for host-side signals, including `usage_limit_reached`, `status_code:429`, and stricter workspace-mismatch detection
- Update package and plugin metadata to the `ngoquocviet2001/codex-keyring` GitHub repository and `NgoQuocViet2001` author identity

## 0.2.2

- Replace the misleading `workspace` label with `organization` and `planType` details from the official Codex auth snapshot
- Clarify that `switch` updates the underlying auth cache for subsequent requests, while Codex app and IDE sessions may need a new request or session reload
- Document that transparent auto-switch is implemented by `codex-keyring exec`, not by in-flight Codex app or IDE requests

## 0.2.1

- Add `codex-keyring info <alias>` for safe per-account details, including email and workspace when available
- Expose the same alias detail view through the MCP server
- Show email and workspace in `codex-keyring list`

## 0.1.1

- Fix alias rename so stats files and event history move with the new alias
- Refresh MCP `accounts.list` and `accounts.status` results the same way as the CLI
- Reset derived stats when an alias is re-registered for a different account
- Simplify English and Vietnamese README guides around npm installation, plugin usage, aliases, supported platforms, and MIT licensing

## 0.1.0

- Initial scaffold for `codex-keyring`
- Native Codex plugin structure
- Helper CLI, MCP server, installer, and guide scaffold
