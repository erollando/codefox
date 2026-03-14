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
- CodeFox aborts in-flight Codex runs, waits briefly for shutdown, ends polling, then writes `service_stop`.
- On startup, pending Telegram backlog can be discarded when `telegram.discardBacklogOnStart=true`.

## Verification

Run before deployment:

```bash
npm run verify
```

## Logs

- Audit logs are JSON lines at `audit.logFilePath` in config.
- Codex progress events include stream tags (`[stdout]`/`[stderr]`) in `codex_progress` line previews.
- Audit log size is bounded by `audit.maxFileBytes` (default 5 MiB); file is truncated when the limit is exceeded.
- Startup logs include detected Codex CLI version; if version is outside tested range, `codex_version_compatibility_warning` is emitted.
- Each request and lifecycle action is logged with event type and timestamp.
- Request/progress payloads are stored as redacted previews to reduce secret leakage risk.
- If startup TTL pruning removes stale records, a `state_pruned` event is written.
- If stale `activeRequestId` values are found on startup, they are cleared and logged as `state_active_requests_cleared`.
- To mirror audit events to stdout, set `CODEFOX_AUDIT_STDOUT=1`.

## Persistent State

- Session state (and any legacy approval records) are stored in `state.filePath` (default `./.codefox/state.json`).
- This allows `/repo`, `/mode`, and Codex session thread state to survive restarts.
- In-progress request IDs are not resumed after restart; stale ones are cleared at startup.
- Optional `state.sessionTtlHours` and `state.approvalTtlHours` prune stale records on startup.
- `state.codexSessionIdleMinutes` closes stale Codex thread sessions after idle timeout.
- If state file is missing/corrupt, CodeFox starts with empty in-memory state.

## Operational Commands (Telegram)

- `/status` to inspect selected repo, mode, active request, and codex session id
- `/reasoning <minimal|low|medium|high|xhigh|default>` (or `/effort ...`) to set per-chat reasoning effort override
- `/run <instruction>` to execute work
- `/steer <instruction>` to steer an active run (interrupt + resume fallback)
- `/close` to close stored Codex session thread explicitly
- `/abort` to stop active Codex execution
- `/repo add <name> <absolute-path>` to register a repo at runtime
- `/repo init <name> [base-path]` to create, `git init`, register, and auto-select a repo
- `/repo bootstrap <name> <python|java|nodejs> [base-path]` to init/register, apply local AGENTS template, and scaffold playbook docs
- `/repo template <name> <python|java|nodejs>` to apply local AGENTS template to an existing repo
- `/repo playbook <name> [overwrite]` to scaffold or refresh `SPEC.md`, `MILESTONES.md`, `RUNBOOK.md`, `VERIFY.md`, `STATUS.md`
- `/repo guide [name]` to inspect AGENTS/playbook coverage and get next-step guidance
- `/repo remove <name>` to remove a registered repo
- `/repo info [name]` to inspect mapped repo path
- `/mode <observe|active|full-access>` to set execution policy mode
- Optional AGENTS guard: when enabled, `/run` in non-observe mode requires `AGENTS.md` in repo root.
- Optional instruction policy can block:
  - blocked text patterns
  - forbidden path references (for example `.env`, `*.key`, `.ssh/**`)
  - download URLs outside allowed domains
- If `forbiddenPathPatterns` is not configured, CodeFox uses a secure default set for common secret paths/files.
- Codex subprocess environment is filtered by `codex.blockedEnvVars` before run start.
- Codex runtime tuning can be set in config via `codex.model`, `codex.reasoningEffort`, and `codex.configOverrides`.
- Image/document prompts are supported: upload attachment(s) and then send `/run ...`, or include a caption on upload.
- Attachment context is consumed by the next `/run` or `/steer` and then cleared.
- `/repo bootstrap` and `/repo template` apply downstream `AGENTS.md` templates intended for normal git tracking.

## Troubleshooting

1. `Unauthorized.` responses:
- verify `allowedUserIds` and optional `allowedChatIds`

2. Polling not receiving updates:
- verify bot token
- verify bot privacy/chat permissions in Telegram
- verify `telegram.discardBacklogOnStart` setting matches desired startup behavior

3. Codex run failures:
- verify `codex.command` and `codex.runArgTemplate`
- for Codex CLI use non-interactive mode (`codex.baseArgs` should include `exec`)
- unless overridden in `baseArgs`, CodeFox injects sandbox by mode (`observe` read-only, `active` workspace-write, `full-access` danger-full-access)
- verify Codex preflight in startup logs (`codex.preflightEnabled`, args, timeout)
- verify repository root exists and is accessible
- inspect audit log `codex_finish` fields (`summaryPreview`, `exitCode`, `timedOut`, `aborted`)
- for Python bootstrap tasks, use project interpreter-scoped pip (`.venv/bin/python -m pip ...` on Linux/macOS, `.venv\\Scripts\\python.exe -m pip ...` on Windows) instead of guessing `pip` vs `pip3`
- if output shows package index/DNS failures (for example `/simple/...` retries or `Name or service not known`), treat as sandbox/network limitation; run bootstrap directly on host shell or switch to `/mode full-access` only in trusted environments

4. Stuck long-running run:
- send `/abort`
- check whether process exit is reflected in audit log
