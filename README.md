# CodeFox

**Secure remote developer delegation.**

CodeFox lets you start work at your desk, continue from your phone, and keep policy, approvals, and audit under your control.

## Who This Is For

- **Solo developer**: keep coding moving when away from your desk.
- **Tech lead**: delegate execution while keeping review/approval checkpoints.
- **On-call engineer**: run bounded checks and triage safely from mobile.

## 60-Second Quickstart

### Goal 1: Run work from Telegram

```bash
npm install
cp config/codefox.config.sample.json config/codefox.config.json
cp .env.example .env
npm run dev
```

Then in Telegram:

```text
/repo <your-repo>
/mode active
/spec draft investigate failing CI on branch feature/foo
/spec approve
run full checks and summarize failures
```

What happens:
- CodeFox routes your request to Codex under the selected mode.
- You get concise progress/completion updates.
- Use `/details` for full technical context.
- Stop an active run with `/abort`.
- Close the current Codex session context with `/close`.

### Goal 2: Handoff desk work to phone

Prerequisite: set `"externalRelay": { "enabled": true, ... }` in `config/codefox.config.json` (and set relay token env var if configured).

At your desk (same machine where CodeFox is running):

```bash
npm run handoff:cli
```

Then in Telegram:

```text
/handoff show
/continue
```

What happens:
- CodeFox binds to the active external route, ingests handoff state, and continues remaining work.
- If multiple items exist, CodeFox defaults safely and lets you choose by id or index (`/continue 2`).
- If `handoff:cli` auto-starts CodeFox, it runs in background; for live logs, start `npm run dev` in another terminal.

### Goal 3: Use local chat-like CLI

```bash
npm run cli
```

If CodeFox runtime is not running yet, the CLI auto-starts it in background.

Inside REPL:

```text
status
what changed in the last run?
:handoff
:continue rw-1
```

### Goal 4: Use local web UI

```bash
npm run ui
```

Open `http://127.0.0.1:8789` in your browser.
If CodeFox runtime is not running yet, UI auto-starts it in background.

What you can do in UI:
- see active sessions (repo, mode, active request)
- view live transcript (incoming commands + CodeFox replies)
- use quick action buttons (`/status`, `/continue`, `/approve`, `/abort`, ...)
- send plain text or slash commands without Telegram
- use compact mobile layout on small screens (or force with `?mobile=1`)
- open the same UI from phone (trusted LAN) to continue away from your desk

UI behavior:
- by default, UI binds to `127.0.0.1` (local machine only)
- header/actions/composer stay fixed; transcript is the primary scroll area
- top quick-actions are the main action surface (message-level duplicate buttons are intentionally hidden)
- laptop UI and mobile UI read the same CodeFox state, so both surfaces show the same sessions, handoffs, and transcript context

Optional LAN access (trusted network only):

```bash
npm run ui -- --host 0.0.0.0 --port 8789
```

Read-only dashboard view is still available:

```bash
npm run dashboard
```

One-shot snapshot:

```bash
npm run local:cli -- dashboard
```

Stop background dev instance:

```bash
npm run dev:stop
```

## Trust Boundary

CodeFox is the authority. External workers are executors.

![CodeFox Trust Boundary](./docs/assets/trust-boundary.svg)

## Common Use Cases

1. **Desk-to-pocket continuation**
- You are mid-feature in an external Codex client, leave your desk, and continue from Telegram with `/handoff` + `/continue`.

2. **Approval-gated risky step**
- Worker asks for approval before a mutating action; you decide with `/approve` or `/deny`.

3. **Fast incident triage**
- From phone, run bounded checks, gather logs, and post Jira updates without opening a laptop session.

## Current Limits

- Capability packs exist as policy contracts; only `jira` is currently marked as native-backed (`implemented`), while other packs are `planned`.
- Changelog-driven capability tracking is currently manual.
- Behavior can still depend on installed Codex CLI/runtime version.

## Documentation By Goal

- **Start/operate/troubleshoot**: [Manual](./docs/MANUAL.md)
- **Desk-to-pocket walkthrough**: [Demo: Remote Handoff](./docs/DEMO_REMOTE_HANDOFF.md)
- **One-page end-user story**: [Demo: One-Page Story](./docs/DEMO_ONE_PAGE_STORY.md)
- **Example transcript output**: [demo-outputs/remote-handoff-transcript.txt](./docs/demo-outputs/remote-handoff-transcript.txt)
- **Capability backend status + promotion checklist**: [Capability Backends](./docs/CAPABILITY_BACKENDS.md)

## Product Statement

CodeFox converts messy human requests into structured, reviewable execution and runs them through policy-bounded workers with full approval and audit control.
