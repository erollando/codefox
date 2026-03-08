# CodeFox

CodeFox is a thin Telegram control plane for Codex.

It authenticates Telegram users/chats, maps requests to approved repositories, applies policy constraints, invokes Codex, and returns concise Telegram-friendly results.

## Architecture

- Telegram adapter: polling transport in v1, webhook-ready boundary.
- Controller (`CodeFoxController`): command routing, session state, policy checks, approvals, execution coordination.
- Safety layers:
  - access control (user/chat allowlists)
  - repo root safety
  - policy modes (`observe`, `active`, `full-access`)
- Codex adapter: CLI invocation with `runArgTemplate`, mode sandbox mapping, and thread-resume support.
- Audit logging: structured JSON lines with redacted previews for request/progress text.

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
- `full-access` requires explicit `/approve` before each `/run`.
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
- `/repo <name>`
- `/repo add <name> <absolute-path>`
- `/repo init <name> [base-path]`
- `/repo remove <name>`
- `/repo info [name]`
- `/mode <observe|active|full-access>`
- `/observe | /active | /full-access`
- `/run <instruction>`
- `/steer <instruction>`
- `/close`
- `/status`
- `/pending`
- `/approve`
- `/deny`
- `/abort`

Plain text (non-slash) input is treated as `/run <text>`.

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
    "runArgTemplate": ["{instruction}"],
    "repoArgTemplate": [],
    "timeoutMs": 1800000,
    "blockedEnvVars": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_TOKEN", "CODEFOX_*"],
    "preflightEnabled": true,
    "preflightArgs": ["--version"],
    "preflightTimeoutMs": 5000
  },
  "policy": { "defaultMode": "observe" },
  "repoInit": {
    "defaultParentPath": "./git"
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
  "audit": { "logFilePath": "./logs/audit.log" }
}
```

`state.filePath` persists chat sessions and pending approvals across service restarts.
If set, `state.sessionTtlHours` and `state.approvalTtlHours` prune stale records on startup.
`state.codexSessionIdleMinutes` controls idle closure for stored Codex session threads.
`/repo init <name>` creates `<defaultParentPath>/<name>`, runs `git init`, registers it, and auto-selects it for the chat.
`telegram.discardBacklogOnStart` drops offline backlog updates on startup (recommended for safety).

## Environment variables

CodeFox auto-loads `.env` from the project root on startup.

- `TELEGRAM_BOT_TOKEN`: required Telegram bot token
- `CODEFOX_CONFIG`: optional config path (default `./config/codefox.config.json`)
- `CODEFOX_AUDIT_STDOUT`: set to `1` to mirror audit events to stdout
- `CODEFOX_ENV_FILE`: optional path to an alternate env file (default `.env`)

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
