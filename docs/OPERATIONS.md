# Operations Runbook

## Purpose

This runbook covers day-1/day-2 operations for running CodeFox as a single-operator Telegram control plane for Codex.

## Preconditions

- Node.js 20+
- `codex` command available on PATH
- Telegram bot token configured
- `config/codefox.config.json` present
- Repositories listed in config are valid local paths
- `TELEGRAM_BOT_TOKEN` set in environment (or `.env`)

## Start

Development:

```bash
npm run dev -- ./config/codefox.config.json
```

Production-like:

```bash
npm run build
npm start -- ./config/codefox.config.json
```

## Stop

- Send `SIGINT` (`Ctrl+C`) or `SIGTERM`.
- CodeFox performs graceful stop by ending polling and writing `service_stop` audit event.
- On startup, pending Telegram backlog can be discarded when `telegram.discardBacklogOnStart=true`.

## Verification

Run before deployment:

```bash
npm run verify
```

## Logs

- Audit logs are JSON lines at `audit.logFilePath` in config.
- Each request and lifecycle action is logged with event type and timestamp.
- Request/progress payloads are stored as redacted previews to reduce secret leakage risk.
- If startup TTL pruning removes stale records, a `state_pruned` event is written.
- To mirror audit events to stdout, set `CODEFOX_AUDIT_STDOUT=1`.

## Persistent State

- Session and approval state are stored in `state.filePath` (default `./.codefox/state.json`).
- This allows `/repo` and `/mode` state to survive restarts.
- Optional `state.sessionTtlHours` and `state.approvalTtlHours` prune stale records on startup.
- If state file is missing/corrupt, CodeFox starts with empty in-memory state.

## Operational Commands (Telegram)

- `/status` to inspect selected repo, mode, active request
- `/pending` to inspect the pending approval request details
- `/abort` to stop active Codex execution
- `/repo add <name> <absolute-path>` to register a repo at runtime
- `/repo init <name> [base-path]` to create, `git init`, register, and auto-select a repo
- `/repo remove <name>` to remove a registered repo
- `/repo info [name]` to inspect mapped repo path
- `/mode <observe|active|full-access>` to set execution policy mode
- Approval ownership rule: only the user who created a pending request can approve or deny it.
- Optional AGENTS guard: when enabled, `/task` requires `AGENTS.md` in repo root.
- Optional instruction policy: when configured, `/task` or `/ask` can be blocked by:
  - blocked text patterns
  - forbidden path references (for example `.env`, `*.key`, `.ssh/**`)
  - download URLs outside allowed domains
- If `forbiddenPathPatterns` is not configured, CodeFox uses a secure default set for common secret paths/files.
- Codex subprocess environment is filtered by `codex.blockedEnvVars` before task start.

## Troubleshooting

1. `Unauthorized.` responses:
- verify `allowedUserIds` and optional `allowedChatIds`

2. Polling not receiving updates:
- verify bot token
- verify bot privacy/chat permissions in Telegram
- verify `telegram.discardBacklogOnStart` setting matches desired startup behavior

3. Codex task failures:
- verify `codex.command` and argument templates
- for Codex CLI use non-interactive mode (`codex.baseArgs` should include `exec`)
- unless overridden in `baseArgs`, CodeFox injects sandbox by mode (`observe` read-only, `active` workspace-write, `full-access` danger-full-access)
- verify Codex preflight in startup logs (`codex.preflightEnabled`, args, timeout)
- verify repository root exists and is accessible
- inspect audit log `codex_finish` fields (`summaryPreview`, `exitCode`, `timedOut`, `aborted`)
- for Python bootstrap tasks, use project interpreter-scoped pip (`.venv/bin/python -m pip ...` on Linux/macOS, `.venv\\Scripts\\python.exe -m pip ...` on Windows) instead of guessing `pip` vs `pip3`
- if output shows package index/DNS failures (for example `/simple/...` retries or `Name or service not known`), treat as sandbox/network limitation; run bootstrap directly on host shell or switch to `/mode full-access` only in trusted environments

4. Stuck long-running task:
- send `/abort`
- check whether process exit is reflected in audit log
