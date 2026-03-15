# Operations Runbook

## Purpose

This runbook covers day-1/day-2 operations for running CodeFox as a single-operator Telegram control plane for Codex.
Remote scope note: "remote" (internet) control currently means Telegram. LAN/browser control is handled by the local web UI.

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
- From Telegram/local UI: `/stop` then `/stopconfirm` (or `/service stop` then `/service stop confirm`).
- For an interactive handoff-started foreground process, stop it in the same terminal with `Ctrl+C`.
- For auto-started/background dev process: `npm run dev:stop -- --config <path>`.
- CodeFox aborts in-flight Codex runs, waits briefly for shutdown, ends polling, then writes `service_stop`.
- On startup, pending Telegram backlog can be discarded when `telegram.discardBacklogOnStart=true`.

## Verification

Run before deployment:

```bash
npm run verify
```

## Logs

- Audit logs are JSON lines at `audit.logFilePath` in config.
- Local UI transcript mirror is stored at `<state-dir>/local-chat-log.jsonl` (derived from `state.filePath`).
- Local UI transcript mirror is capped by `state.chatLogMaxFileBytes` (default 2 MiB) and retains the newest window within that cap.
- Paired UI devices are stored at `<state-dir>/ui-devices.json` (derived from `state.filePath`).
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
- `/details` for expanded technical context (session + handoff + approval pointers)
- `/codex-changelog` to fetch the official Codex RSS feed, compare against the persisted baseline, and report new entries vs no-change with impact hints
- `/accept` / `/reject` are the primary handoff confirmation actions.
- `/handoff show` shows the current handoff bundle and remaining work.
- `/continue` is the primary continue action when handoff work is ready.
- `/continue [work-id|index]` remains available as shorthand when you need a typed continue command.
- `/resume [work-id|index]` as alias of `/continue`
- External handoff carries task context only; it does not import/attach the external desk-side Codex process.
- Accepting a handoff does not take control of the original external Codex thread. CodeFox takes ownership only of the stored handoff bundle and any new CodeFox-managed continuation run.
- Accepted handoffs can stay in `waiting_for_external_completion` until the external client sends a `completion` event. When that arrives, CodeFox starts its own continuation automatically if the handoff is otherwise runnable.
- Continuation runs in CodeFox-managed Codex session lifecycle. Unless an external client explicitly provides a resumable thread/session id in a future protocol revision, this is context continuity rather than same-thread takeover.
- `/reasoning <minimal|low|medium|high|xhigh|default>` (or `/effort ...`) to set per-chat reasoning effort override
- `/run <instruction>` to execute work
- `/steer <instruction>` to steer an active run (interrupt + resume fallback)
- If no repo is selected, CodeFox auto-selects a default repo (single configured repo or most-recent context) and reports it.
- Plain text while a run is active is treated as steer guidance automatically.
- Plain text while a run is being prepared is queued as follow-up and auto-applied when the run starts.
- Run updates are concise by default; ask `/details` when you need full technical context.
- `/close` to close stored Codex session thread explicitly
- `/abort` to stop active Codex execution
- `/stop` to request a clean service shutdown (requires `/stopconfirm`; legacy `/service stop [confirm]` also works)
- `/repo add <name> <absolute-path>` to register a repo at runtime
- `/repo init <name> [base-path]` to create, `git init`, register, and auto-select a repo
- `/repo bootstrap <name> <python|java|nodejs> [base-path]` to init/register, apply local AGENTS template, and scaffold playbook docs
- `/repo template <name> <python|java|nodejs>` to apply local AGENTS template to an existing repo
- `/repo playbook <name> [overwrite]` to scaffold or refresh `SPEC.md`, `MILESTONES.md`, `RUNBOOK.md`, `VERIFY.md`, `STATUS.md`
- `/repo guide [name]` to inspect AGENTS/playbook coverage and get next-step guidance
- `/repo remove <name>` to remove a registered repo
- `/repo info [name]` to inspect mapped repo path
- `/mode <observe|active|full-access>` to set execution policy mode
- `/policy [observe|active|full-access]` to inspect effective policy and spec rules
- `/capabilities [pack]` to inspect typed action contracts and backend maturity (`implemented` vs `planned`)
- `/act <pack.action> <instruction>` to execute typed capability actions
- `/audit <view_id>` to inspect policy/status view audit records
- Optional AGENTS guard: when enabled, `/run` in non-observe mode requires `AGENTS.md` in repo root.
- Optional instruction policy can block:
  - blocked text patterns
  - forbidden path references (for example `.env`, `*.key`, `.ssh/**`)
  - download URLs outside allowed domains
- If `forbiddenPathPatterns` is not configured, CodeFox uses a secure default set for common secret paths/files.
- Codex subprocess environment is filtered by `codex.blockedEnvVars` before run start.
- Codex runtime tuning can be set in config via `codex.model`, `codex.reasoningEffort`, and `codex.configOverrides`.
- Image/document prompts are supported: upload attachment(s) and then send `/run ...`, or include a caption on upload.
- Attachment context is consumed by the next `/run`, `/act`, or `/steer` and then cleared.
- `/repo bootstrap` and `/repo template` apply downstream `AGENTS.md` templates intended for normal git tracking.
- Telegram run updates are concise by default (summary-first). Use `/status` when you need full session metadata.
- Changelog checks persist seen entry IDs in state so repeated `/codex-changelog` runs only report newly published items.

## External Relay (Optional)

- Enable `externalRelay` in config to expose local HTTP adapter for external Codex clients.
- Local web UI: `npm run ui` (default `http://127.0.0.1:8789`).
  - shows active sessions/spec/approvals/handoff summary
  - shows mirrored transcript (incoming commands + CodeFox replies)
  - provides quick command buttons and free-text input
  - quick actions submit slash commands directly so control input is explicit
  - auto-starts CodeFox runtime in background if missing
  - loopback requests are trusted; non-loopback requests require paired-device cookie auth
  - in LAN mode (`--host 0.0.0.0`), startup prints one-time pair QR/link (`/pair?code=...`) for phone registration
- For an operator-facing handoff bridge without manual API calls, use:
  - `npm run handoff:cli -- --config <path> [--completed "<item>"]`
  - Optional overrides: `<chatId>` positional, `--task <taskId>`, `--remaining "<summary>"`, `--repo-path <path>`, `--start-in-foreground`, `--start-in-background`, `--no-start-if-missing`.
  - `--start-if-missing` is kept as a compatibility alias for `--start-in-background`.
  - The command automates route lookup, lease bind, completion event, handoff submission, and lease revoke (auto-generates task id, auto-derives remaining summary, and if multiple routes exist asks for an explicit route choice with default to most recently used).
  - If explicit `chatId` is provided but local session state is missing, route resolution falls back to active relay routes for that chat.
  - Handoff payload includes source repo metadata; CodeFox continuation auto-aligns repo and can auto-register when source path is provided.
  - If relay is unreachable on an interactive terminal, `handoff:cli` prompts `[F/b/N]` and defaults to foreground start.
  - Foreground start keeps the handoff terminal attached to `npm run dev -- <path>` after submission; stop it there with `Ctrl+C`.
  - Background start is explicit (`--start-in-background` or legacy `--start-if-missing`), prints a cross-platform stop command, and writes `<state-dir>/codefox.dev.pid`.
- `handoff:cli` is still a one-shot bridge command. It submits a finished-phase handoff bundle; it cannot keep a lease open and emit a later completion event after the command exits.
- `handoff:cli` does not export the external Codex thread/session id, so CodeFox cannot resume that exact external thread after takeover. The follow-up run starts from the submitted handoff context.
- Its terminal output now points users to `/accept` as the primary Telegram/UI next step; `/handoff show` remains the optional inspection path.
  - If the target chat has no local spec workflow yet, CodeFox auto-bootstraps and approves one at ingest time.
  - Demo split:
    - `npm run demo:handoff` shows the desk terminal action and relay calls.
    - `npm run demo:handoff-lifecycle` shows the later accept/wait/auto-continue lifecycle inside CodeFox.
- Endpoints:
  - `GET /health` (always unauthenticated)
  - `GET /v1/external-codex/routes`
  - `GET /v1/external-codex/approval?leaseId=<id>&approvalKey=<key>`
  - `POST /v1/external-codex/bind`
  - `POST /v1/external-codex/heartbeat`
  - `POST /v1/external-codex/revoke`
  - `POST /v1/external-codex/event`
  - `POST /v1/external-codex/handoff`
- If `externalRelay.authTokenEnvVar` is set, requests must include `Authorization: Bearer <token>`.
- `approval_request` events are relayed into CodeFox approval flow; external clients must poll approval status and must not bypass `/approve`/`/deny`.
- One active external lease is allowed per CodeFox session id; clients must revoke before rebinding.

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
