# Changelog

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
