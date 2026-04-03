# AGENTS.md

## Mission

Build `codex-accounts` as a native multi-account manager for Codex app, Codex CLI, and the Codex IDE extension.

This project is explicitly **not** a proxy, router, or custom OpenAI-compatible endpoint. It must stay close to Codex-native auth, Codex-native plugin installation, and Codex-native account switching.

## Source Of Truth

The long-lived source of truth for this repository is:

1. `README.md`
2. `AGENTS.md`
3. `src/`
4. `tests/`

## Product Rules

- Always use the official `codex login` flow to add accounts.
- Never reimplement OAuth, device auth, or ChatGPT login flows.
- Never require users to change `OPENAI_BASE_URL`.
- Never introduce a proxy architecture into the mainline product.
- Treat Codex app, CLI, and IDE extension as first-class target surfaces.

## Security Rules

- Never print or log raw `access_token`, `refresh_token`, `id_token`, or `OPENAI_API_KEY`.
- Never commit auth snapshots, local stores, or user-specific credential paths.
- Redact secrets in errors, diagnostics, and tests.
- Treat `~/.codex/auth.json` and `~/.codex-accounts/accounts/*/auth.json` like passwords.
- Any debug output must use fingerprints or presence flags, never raw values.

## Auth And Switching Rules

- All account switching must be atomic and rollback-safe.
- Always write a temp file first, validate it, then replace the active auth cache.
- Keep a recovery backup before changing the active auth file.
- `auto-switch` may only trigger for classified quota, auth-expired, workspace-mismatch, or rate-limited failures.
- Generic network errors must not rotate accounts by default.
- `codex-accounts exec` may retry exactly once after a successful failover.
- The app and IDE extension may use the switched account only for the next request. Do not promise in-flight seamless continuation.

## Managed Mode Rules

- Managed multi-account mode assumes file-backed Codex auth.
- `doctor` must warn if `cli_auth_credentials_store` is `keyring` or `auto`.
- `install` may enable file-backed auth mode in `~/.codex/config.toml` with clear metadata and reversible state.
- If a future implementation touches the keyring path, it must be opt-in and documented before merge.

## Stats Rules

- Every limit or usage summary must expose a confidence level: `exact`, `estimated`, or `manual`.
- Do not present estimated quota numbers as exact facts.
- Explain the data source when confidence is not `exact`.

## Platform Rules

- `codex-accounts` should target the same operating-system surface as the official Codex CLI: Windows, macOS, Linux, WSL, and containerized environments where Codex is supported.
- Windows remains a first-class target and must stay explicitly tested.
- Path and process handling must use Node `path`, `os`, and `fs` utilities plus shell-aware invocation helpers instead of OS-specific scripts.
- New auth, install, or smoke-test flows must not assume PowerShell, `%USERPROFILE%`, or other Windows-only conventions unless they also provide a POSIX-safe path.
- File locking and atomic replace behavior must be considered before merging auth-related changes.

## Documentation Rules

- `README.md` must be guide-first and easy to read like library documentation.
- `README.md` is the primary English guide.
- `README.vi.md` must exist as a separate Vietnamese guide and mirror the structure and intent of `README.md`.
- The documentation must focus on published-package installation and real user workflows.
- The documentation must include installation, quick start, app/IDE usage, common workflows, supported platforms, command reference, troubleshooting, and license.
- Documentation examples must use generic aliases such as `account1`, `account2`, `account3`, `alice-work`, or `alice-personal`.
- Documentation examples must not use user-specific paths, filenames, or local machine examples.
- `AGENTS.md` must stay aligned with release rules, versioning, and security guarantees.

## Versioning Rules

Use SemVer across:

- `package.json`
- `.codex-plugin/plugin.json`
- `CHANGELOG.md`

Bump rules:

- `patch`: bug fix, refactor, internal cleanup, docs-only change without user-facing contract change
- `minor`: new command, new MCP tool, new backward-compatible installer behavior, new visible capability
- `major`: breaking CLI contract, breaking state schema, breaking install flow, breaking MCP interface

If user-facing behavior changes and the version was not updated accordingly, treat that as a release blocker.

## Packaging And Release Rules

- Local package validation must go through `npm pack` and `.tgz` install testing before any publish workflow.
- Do not publish if `README.md`, `AGENTS.md`, and `CHANGELOG.md` disagree with the current version or behavior.
- Keep package payload lean via `files` whitelist and `.npmignore`.

## Testing Rules

Minimum checks before considering a milestone complete:

- `npm run build`
- `npm test`
- local `npm pack`
- global install from `.tgz`
- `codex-accounts install`
- `codex-accounts doctor`

Auth, switching, marketplace installation, and release-guard logic should not ship without tests.
