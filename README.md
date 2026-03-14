# CodeFox

CodeFox is a secure remote delegation layer for developer work.
You describe what you need in plain language, CodeFox turns it into a reviewable spec, enforces policy and approvals, and executes through Codex and typed local/cloud capabilities.

The practical outcome: you can start from your desk, continue from your phone, and keep control of risk-sensitive actions.

## What You Can Do Today

- Start work from Telegram with short natural requests.
- Convert requests into structured specs that are diffable and approvable.
- Run policy-bounded capability actions (`repo`, `jira`, `docs`, `ops`, `mail`, `calendar`).
- Receive structured progress and approval checkpoints during execution.
- Continue long-running work remotely via external Codex handoff into CodeFox.

## Setup
One-time: configure your codefox.config.json ...
Optionally link to mcp like jira
...


## Start Here

```bash
npm install
cp config/codefox.config.sample.json config/codefox.config.json
cp .env.example .env
# edit config and .env
npm run dev
```

Optional explicit config path:

```bash
npm run dev -- ./config/codefox.config.json
```

## Run A Concrete Demo

Desk-to-pocket continuation demo (external Codex -> CodeFox handoff):

```bash
npm run demo:remote-handoff
```

- Full walkthrough: [Demo: Desk-to-Pocket Continuation](./docs/DEMO_REMOTE_HANDOFF.md)
- One-page version: [One-Page Story](./docs/DEMO_ONE_PAGE_STORY.md)
- Sample output: [remote-handoff-transcript.txt](./docs/demo-outputs/remote-handoff-transcript.txt)

## Documentation Map

- Operations and troubleshooting: [docs/OPERATIONS.md](./docs/OPERATIONS.md)
- Demo walkthroughs: [`docs/DEMO_REMOTE_HANDOFF.md`](./docs/DEMO_REMOTE_HANDOFF.md), [`docs/DEMO_ONE_PAGE_STORY.md`](./docs/DEMO_ONE_PAGE_STORY.md)
- Agent templates for downstream repos: [templates/agents/README.md](./templates/agents/README.md)

## Core Product Flow

1. User sends messy intent.
2. CodeFox compiles it into a structured draft/spec.
3. User reviews, clarifies, approves checkpoints.
4. Worker executes under policy constraints.
5. CodeFox reports progress, blockers, approvals, and completion.
6. If needed, remaining work is packaged and continued remotely.

## Key Principles

- CodeFox is the authority for policy, approvals, user communication, and audit.
- External workers do not own Telegram/user channels.
- External workers do not get arbitrary laptop control.
- The laptop executes only typed, policy-checked actions.

## What CodeFox Is Not

- Not a remote desktop replacement.
- Not a second coding agent that bypasses Codex.
- Not a free-form laptop control channel.

## Commands (Telegram)

Main commands:

- `/help`
- `/repos`
- `/repo <name>`
- `/mode <observe|active|full-access>`
- `/observe | /active | /full-access`
- `/run <instruction>`
- `/act <pack.action> <instruction>`
- `/steer <instruction>`
- `/status`
- `/abort`
- `/close`

Spec workflow:

- `/spec template`
- `/spec draft <intent>`
- `/spec clarify <note>`
- `/spec show`
- `/spec status`
- `/spec diff`
- `/spec approve [force]`
- `/spec clear`

Capabilities and policy:

- `/capabilities [mail|calendar|repo|jira|ops|docs]`
- `/policy [observe|active|full-access]`
- `/reasoning <minimal|low|medium|high|xhigh|default>` (alias: `/effort`)

Repo management:

- `/repo add <name> <absolute-path>`
- `/repo init <name> [base-path]`
- `/repo bootstrap <name> <python|java|nodejs> [base-path]`
- `/repo template <name> <python|java|nodejs>`
- `/repo playbook <name> [overwrite]`
- `/repo guide [name]`
- `/repo remove <name>`
- `/repo info [name]`

Handoff and audit:

- `/handoff [status|show|continue [work-id]|clear]`
- `/audit <view_id>`

Notes:

- Plain text (non-slash) input is treated as `/run <text>`.
- In `active` and `full-access`, untyped `/run` is blocked by capability policy; use typed `/act`.

## Session Model

CodeFox keeps one Codex session thread per chat and reuses it until:

- `/close`
- repo change
- mode change
- idle timeout (`state.codexSessionIdleMinutes`)
- resume rejection from Codex

`/steer` during an active run uses deterministic fallback:

1. interrupt active run
2. merge pending steer messages
3. resume the same Codex session thread

## Safety Model

- Unknown users/chats are denied.
- Modes map to capability boundaries:
  - `observe` -> read-only
  - `active` -> workspace-write
  - `full-access` -> danger-full-access
- Task execution is constrained to configured repo roots.
- Instruction policy can block risky patterns, forbidden paths, and non-allowlisted download domains.
- Forbidden path policy is injected into Codex run guidance.
- Codex subprocess env can be filtered via `codex.blockedEnvVars`.
- Task summaries/output are redacted before Telegram and audit rendering.
- Long Telegram responses are split into ordered message parts.

Default forbidden paths if not configured:

- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `.aws/**`
- `.ssh/**`
- `credentials/**`
- `secrets/**`

## External Codex Integration

CodeFox supports transport-agnostic external Codex integration in two stages:

Stage 1: attached reporting

- External Codex binds with a lease to an active CodeFox session.
- It emits typed events:
  - `progress`
  - `blocker`
  - `approval_request`
  - `completion`
- CodeFox relays user communication, enforces approvals, and stores audit history.

Stage 2: continuation handoff

- After external execution, client submits a typed handoff bundle.
- CodeFox validates spec revision linkage before storing continuation state.
- User continues via `/handoff show` and `/handoff continue [work-id]`.
- Telegram handoff messages include one-tap command buttons for show/continue.

External relay HTTP adapter (optional):

- `GET /health`
- `GET /v1/external-codex/routes`
- `GET /v1/external-codex/approval?leaseId=<id>&approvalKey=<key>`
- `POST /v1/external-codex/bind`
- `POST /v1/external-codex/heartbeat`
- `POST /v1/external-codex/revoke`
- `POST /v1/external-codex/event`
- `POST /v1/external-codex/handoff`

Only one active lease is allowed per external session id; clients must revoke before re-binding.

## Local CLI (Read/Operate Sessions)

```bash
npm run local:cli -- sessions
npm run local:cli -- approvals
npm run local:cli -- specs
npm run local:cli -- session 100
npm run local:cli -- send 100 "/status"
npm run handoff:cli -- --config ./config/codefox.config.json --completed "Endpoint implemented"
```

`send` writes a command envelope into `<state-dir>/local-command-queue/inbox`.
When CodeFox is running, it consumes queued local commands through the same controller/policy/audit path used for Telegram input.
`handoff:cli` is an IDE-agnostic bridge command that automates relay route lookup, lease bind, completion event, and typed handoff submit so users do not need manual `curl` calls; chat/task are auto-resolved by default and can be overridden when needed.
`--remaining` is optional and auto-derived from available context (active request id, Codex thread id) when omitted.
If relay is unreachable, `handoff:cli` can start CodeFox and retry (`--start-if-missing` / `--no-start-if-missing`; interactive prompt by default on TTY).
If no local spec exists for the chat yet, CodeFox auto-bootstraps and approves one during handoff ingest.

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

State and runtime notes:

- `state.filePath` persists sessions, approvals, specs, and external handoff continuation state.
- Stale `activeRequestId` values are cleared on startup.
- `state.sessionTtlHours` and `state.approvalTtlHours` prune stale records on startup.
- `state.codexSessionIdleMinutes` controls idle closure for stored Codex session threads.
- `audit.maxFileBytes` truncates the audit log at the configured limit (default 5 MiB).
- `policy.specPolicy` overrides mode-specific spec requirements.
- If `externalRelay.authTokenEnvVar` is set, startup fails unless env var exists, and clients must send `Authorization: Bearer <token>`.
- `telegram.discardBacklogOnStart` drops offline backlog updates on startup.

Codex runtime options you can set in `codex`:

- `model` -> `--model`
- `reasoningEffort` -> `-c model_reasoning_effort="..."` (`minimal|low|medium|high|xhigh`)
- `profile` -> `--profile` (optional)
- `configOverrides` -> additional `-c key=value`

Jira MCP bridge example (`jira-mcp-bridge` at `/home/enrico/git/jira-mcp-bridge`):

```json
"configOverrides": [
  "mcp_servers={ \"jira-mcp-bridge\" = { command = \"bash\", args = [\"-lc\", \"cd /home/enrico/git/jira-mcp-bridge && exec ./scripts/start-server.sh\"], env = { ACLI_PATH = \"acli\" } } }"
]
```

After updating config, restart CodeFox so new Codex runs load the MCP server.

## Environment Variables

CodeFox auto-loads `.env` from project root.

- `TELEGRAM_BOT_TOKEN`: required Telegram bot token
- `CODEFOX_CONFIG`: optional config path (default `./config/codefox.config.json`)
- `CODEFOX_AUDIT_STDOUT`: set to `1` to mirror audit events to stdout
- `CODEFOX_ENV_FILE`: optional alternate env file path (default `.env`)
- `CODEFOX_EXTERNAL_RELAY_TOKEN`: optional bearer token when `externalRelay.authTokenEnvVar` is configured

Existing shell environment variables take precedence over `.env` values.

For Codex CLI, keep `codex.baseArgs` as `["exec"]` for non-interactive runs.

## Validate

```bash
npm run build
npm test
npm run verify
```
