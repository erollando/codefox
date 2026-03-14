# CodeFox

Codefox is a secure remote developer delegation system that converts messy human requests into reviewed formal specs, then executes them through policy-bounded local and cloud workers.

It authenticates Telegram users/chats, maps requests to approved repositories, applies policy constraints, invokes Codex, and returns concise Telegram-friendly results.

## Architecture

- Telegram adapter: polling transport in v1, webhook-ready boundary.
- Controller (`CodeFoxController`): command routing, session state, policy checks, approvals, execution coordination.
- Safety layers:
  - access control (user/chat allowlists)
  - repo root safety
  - policy modes (`observe`, `active`, `full-access`)
- Codex adapter: CLI invocation with `runArgTemplate`, mode sandbox mapping, and thread-resume support.
- External Codex integration core: leased bind + typed event/handoff schemas for transport-agnostic attached reporting and continuation handoff.
- Audit logging: structured JSON lines with redacted previews for request/progress text (including tagged `[stdout]`/`[stderr]` Codex progress lines).
- Startup records detected Codex CLI version in audit logs and emits a non-blocking compatibility warning when outside tested range.

## Session model

CodeFox keeps a Codex session thread per chat and reuses it until one of these events:

- `/close`
- repo change
- mode change
- idle timeout (`state.codexSessionIdleMinutes`)
- resume rejection reported by Codex

`/steer` during an active run is handled with deterministic fallback semantics:

1. interrupt active run
2. merge pending steer messages
3. resume same Codex session thread

## Safety model

- Unknown users/chats are denied.
- `observe` maps to read-only sandbox, `active` to workspace-write, `full-access` to danger-full-access.
- Optional AGENTS guard can require `AGENTS.md` before `/run` in non-observe modes.
- Optional instruction policy can block risky patterns, forbidden file-path references (like `.env`/keys), and non-allowlisted download domains before Codex starts.
- Forbidden path policy is also injected as execution guidance into Codex prompts.
- If `forbiddenPathPatterns` is omitted, CodeFox applies a secure default set (`.env`, `.env.*`, `*.pem`, `*.key`, `.aws/**`, `.ssh/**`, `credentials/**`, `secrets/**`).
- Codex subprocess env is filtered by `codex.blockedEnvVars` to avoid passing integration secrets.
- Task summaries/output are redacted before Telegram/audit rendering to reduce accidental secret disclosure.
- Task execution is constrained to configured repo roots.
- Long Telegram responses are automatically split into ordered message parts instead of being silently truncated.

## Commands

- `/help`
- `/repos`
- `/capabilities [mail|calendar|repo|jira|ops|docs]`
- `/spec template`
- `/spec draft <intent>`
- `/spec clarify <note>`
- `/spec show`
- `/spec status`
- `/spec diff`
- `/spec approve [force]`
- `/spec clear`
- `/repo <name>`
- `/repo add <name> <absolute-path>`
- `/repo init <name> [base-path]`
- `/repo bootstrap <name> <python|java|nodejs> [base-path]`
- `/repo template <name> <python|java|nodejs>`
- `/repo playbook <name> [overwrite]`
- `/repo guide [name]`
- `/repo remove <name>`
- `/repo info [name]`
- `/mode <observe|active|full-access>`
- `/observe | /active | /full-access`
- `/policy [observe|active|full-access]`
- `/act <pack.action> <instruction>`
- `/reasoning <minimal|low|medium|high|xhigh|default>` (alias: `/effort`)
- `/run <instruction>`
- `/steer <instruction>`
- `/close`
- `/status`
- `/audit <view_id>`
- `/abort`

`/status` also reports effective spec-policy behavior for the current mode (run gate, force-approval behavior, and required approval sections).
`/policy` prints a broader policy snapshot (current/effective mode, global guards, instruction-policy summary, and per-mode spec policy).
Both `/status` and `/policy` include an `audit ref` token that maps to the corresponding audit event.
Use `/audit <view_id>` to fetch the corresponding audit event details from chat.
Use `/capabilities` to inspect capability-pack action coverage and `/capabilities <pack>` for detailed action contracts (inputs, audit fields, rollback hints).
In `active` and `full-access` modes, use typed capability execution via `/act ...`; untyped `/run` is blocked by capability policy.

Plain text (non-slash) input is treated as `/run <text>`.

Spec workflow:

- `/spec draft ...` creates a structured execution spec draft for the current chat.
- Draft initialization creates a revision chain with `v0(raw)` and `v1(interpreted)`.
- `/spec clarify ...` creates a new clarified revision (`v2+`) and records assumptions/context updates.
- `/spec diff` shows line-level changes between the latest two revisions.
- In `active` and `full-access` modes, `/run` and `/act` require an approved current spec.
- In `active` and `full-access` modes, `/spec approve` requires non-empty mutating-mode sections (including `CONSTRAINTS` and `DONE WHEN`).
- `/spec approve force` is only a bypass path for `observe` mode.
- In `observe` mode, `/run` remains allowed without a spec.
- `/spec show` renders the current spec text for review and auditability.

Image/document prompts:

- Upload an image or document, then send `/run <question>` to analyze it.
- You can also use `/act <pack.action> <instruction>` so typed runs consume the same one-shot attachment context.
- You can also upload with a caption; caption text is treated like normal input (`/run` for plain text captions, or a slash command).
- Uploaded attachment context is one-shot: it is consumed by the next `/run`, `/act`, or `/steer` unless you upload again.

Repo bootstrap and local agent docs:

- `/repo bootstrap ...` initializes a repo, applies a local AGENTS template, and scaffolds playbook docs (`SPEC.md`, `MILESTONES.md`, `RUNBOOK.md`, `VERIFY.md`, `STATUS.md`).
- `/repo template ...` applies a template to an existing registered repo.
- `/repo playbook ...` scaffolds or refreshes the same playbook docs for an existing repo.
- `/repo guide ...` reports AGENTS/playbook coverage and recommends next commands.

## Configuration

Copy the sample config to `config/codefox.config.json`:

```json
{
  "telegram": {
    "allowedUserIds": [123456789],
    "allowedChatIds": [123456789],
    "pollingTimeoutSeconds": 30,
    "pollIntervalMs": 1000,
    "discardBacklogOnStart": true
  },
  "repos": [],
  "_note_repos": "Optional: keep repos empty and use /repo init <name> [base-path], or replace with your real repo mappings.",
  "codex": {
    "command": "codex",
    "baseArgs": ["exec"],
    "model": "gpt-5.3-codex",
    "reasoningEffort": "default",
    "configOverrides": [],
    "runArgTemplate": ["{instruction}"],
    "repoArgTemplate": [],
    "timeoutMs": 1800000,
    "blockedEnvVars": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_TOKEN", "CODEFOX_*"],
    "preflightEnabled": true,
    "preflightArgs": ["--version"],
    "preflightTimeoutMs": 5000
  },
  "policy": {
    "defaultMode": "observe",
    "specPolicy": {
      "active": {
        "requiredSectionsForApproval": ["CONSTRAINTS", "DONE_WHEN"],
        "allowForceApproval": false
      },
      "full-access": {
        "requiredSectionsForApproval": ["CONSTRAINTS", "DONE_WHEN"],
        "allowForceApproval": false
      }
    }
  },
  "repoInit": {
    "defaultParentPath": "/home/<your-user>/git"
  },
  "safety": {
    "requireAgentsForRuns": false,
    "instructionPolicy": {
      "blockedPatterns": [],
      "allowedDownloadDomains": [],
      "forbiddenPathPatterns": [
        ".env",
        ".env.*",
        "*.pem",
        "*.key",
        ".aws/**",
        ".ssh/**",
        "credentials/**",
        "secrets/**"
      ]
    }
  },
  "state": {
    "filePath": "./.codefox/state.json",
    "sessionTtlHours": 168,
    "approvalTtlHours": 72,
    "codexSessionIdleMinutes": 120
  },
  "audit": { "logFilePath": "./logs/audit.log", "maxFileBytes": 5242880 },
  "externalRelay": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 8787,
    "authTokenEnvVar": "CODEFOX_EXTERNAL_RELAY_TOKEN"
  }
}
```

`state.filePath` persists chat sessions, pending approvals, and spec workflow revisions across service restarts.
Any stale `activeRequestId` values from a previous process are cleared on startup.
If set, `state.sessionTtlHours` and `state.approvalTtlHours` prune stale records on startup.
`state.codexSessionIdleMinutes` controls idle closure for stored Codex session threads.
`audit.maxFileBytes` bounds the audit log file size (default 5 MiB) by truncating when the limit is reached.
`policy.specPolicy` optionally overrides mode-specific spec requirements (`requireApprovedSpecForRun`, `allowForceApproval`, `requiredSectionsForApproval`).
`externalRelay` enables an optional transport adapter for external Codex clients (`bind`, `event`, `handoff`) on local HTTP.
If `externalRelay.authTokenEnvVar` is set, startup fails unless the env var exists and clients must send `Authorization: Bearer <token>`.
`/repo init <name>` creates `<defaultParentPath>/<name>`, runs `git init`, registers it, and auto-selects it for the chat.
`telegram.discardBacklogOnStart` drops offline backlog updates on startup (recommended for safety).

Codex runtime options you can set in `codex`:

- `model`: maps to `--model`
- `reasoningEffort`: maps to `-c model_reasoning_effort=\"...\"` (`minimal|low|medium|high|xhigh`)
- `profile`: maps to `--profile` (optional)
- `configOverrides`: additional `-c key=value` entries passed through to Codex

Jira MCP bridge example (`jira-mcp-bridge` repo at `/home/enrico/git/jira-mcp-bridge`):

```json
"configOverrides": [
  "mcp_servers={ \"jira-mcp-bridge\" = { command = \"bash\", args = [\"-lc\", \"cd /home/enrico/git/jira-mcp-bridge && exec ./scripts/start-server.sh\"], env = { ACLI_PATH = \"acli\" } } }"
]
```

After updating config, restart CodeFox so new Codex runs load the MCP server.

## Environment variables

CodeFox auto-loads `.env` from the project root on startup.

- `TELEGRAM_BOT_TOKEN`: required Telegram bot token
- `CODEFOX_CONFIG`: optional config path (default `./config/codefox.config.json`)
- `CODEFOX_AUDIT_STDOUT`: set to `1` to mirror audit events to stdout
- `CODEFOX_ENV_FILE`: optional path to an alternate env file (default `.env`)
- `CODEFOX_EXTERNAL_RELAY_TOKEN`: optional bearer token used when `externalRelay.authTokenEnvVar` is configured

Existing shell environment variables take precedence over values in `.env`.

For Codex CLI, keep `codex.baseArgs` set to `["exec"]` so runs are non-interactive.

## Run

```bash
npm install
cp config/codefox.config.sample.json config/codefox.config.json
cp .env.example .env
# edit config and .env
npm run dev
```

Or pass config path explicitly:

```bash
npm run dev -- ./config/codefox.config.json
```

Local CLI (read model for sessions/specs/approvals):

```bash
npm run local:cli -- sessions
npm run local:cli -- approvals
npm run local:cli -- specs
npm run local:cli -- session 100
npm run local:cli -- send 100 "/status"
```

`send` writes a command envelope into a local queue (`<state-dir>/local-command-queue/inbox`).
When CodeFox is running, it consumes queued local commands and executes them through the same controller/policy/audit path used for Telegram input.

External relay HTTP transport (optional):

- `GET /health`
- `GET /v1/external-codex/routes`
- `GET /v1/external-codex/approval?leaseId=<id>&approvalKey=<key>`
- `POST /v1/external-codex/bind`
- `POST /v1/external-codex/heartbeat`
- `POST /v1/external-codex/revoke`
- `POST /v1/external-codex/event`
- `POST /v1/external-codex/handoff`

When enabled, routes are derived from active CodeFox sessions (`chat:<id>/repo:<name>/mode:<mode>`). The relay remains transport-agnostic; this HTTP server is a thin adapter boundary suitable for future VS Code plugin/skill clients.
`approval_request` events are converted into CodeFox pending approvals and must be resolved by `/approve` or `/deny` inside CodeFox channels.

## Validate

```bash
npm run build
npm test
npm run verify
```

## Operations

Operational run/stop/troubleshooting guidance: [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).

## Agent templates

Language starter templates for downstream repository `AGENTS.md` files are available in [`templates/agents`](./templates/agents/README.md):

- Python
- Java
- Node.js
