# CodeFox

**Secure remote developer delegation.**

CodeFox is a control plane for Codex work: you can start locally, continue remotely, and keep approvals, policy, and audit in one place.

## What You Get

- One shared session state across Telegram, local UI, and local REPL.
- Structured, approval-aware execution instead of ad-hoc remote control.
- Seamless switch between desk and phone without losing context.

## Who This Is For

- **Solo developer**: keep work moving when away from desk.
- **Tech lead**: delegate execution with explicit checkpoints.
- **On-call engineer**: run triage flows safely from mobile.

## Quickstart

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

## Interaction Surfaces

### Telegram
Use Telegram for fast control and notifications:

- start requests
- approve/deny
- continue handoff work
- get concise run updates

Useful commands:

```text
/status
/details
/approve
/deny
/continue
/abort
```

### Local Web UI

```bash
npm run ui
```

Open: `http://127.0.0.1:8789`

What it does:

- shows active sessions, specs, handoffs, and live transcript
- provides compact quick-action buttons
- sends plain text or slash commands
- keeps top controls fixed and scrolls transcript area

Runtime behavior:

- if CodeFox is not running, UI auto-starts it in background
- default bind is local-only (`127.0.0.1`)
- local loopback access is trusted (no pairing required)

Phone access (trusted LAN):

```bash
npm run ui -- --host 0.0.0.0 --port 8789
```

Open from phone: `http://<laptop-lan-ip>:8789`

Device pairing flow:

- when UI starts in LAN mode, terminal prints one-time pair link(s) and a QR code
- scan the QR from phone once
- phone browser is registered as a paired device and can open UI afterward
- non-paired remote devices are denied

Mobile mode:

- automatic on small screens
- force with `?mobile=1`

Important: laptop UI and phone UI show the same CodeFox data and session state, so switching between local and remote work stays consistent.

### Local REPL

```bash
npm run cli
```

If CodeFox is not running, REPL auto-starts it in background.

Example:

```text
status
what changed in the last run?
:handoff
:continue rw-1
```

### External Handoff (Desk -> Remote)

Prerequisite: `externalRelay.enabled=true` in `config/codefox.config.json`.

At desk:

```bash
npm run handoff:cli
```

Then from Telegram/UI:

```text
/handoff show
/continue
```

## Operational Helpers

```bash
npm run dev:stop
npm run dashboard
npm run local:cli -- dashboard
```

## Trust Boundary

CodeFox is the authority for policy, approvals, communication, and audit. External workers execute within that boundary.

![CodeFox Trust Boundary](./docs/assets/trust-boundary.svg)

## Current Limits

- Capability packs exist as policy contracts; only `jira` is currently marked as native-backed (`implemented`).
- Changelog-driven capability tracking is still manual.
- Runtime behavior can depend on installed Codex CLI version.

## Documentation

- Start/operate/troubleshoot: [Manual](./docs/MANUAL.md)
- Desk-to-pocket walkthrough: [Demo: Remote Handoff](./docs/DEMO_REMOTE_HANDOFF.md)
- End-user narrative: [Demo: One-Page Story](./docs/DEMO_ONE_PAGE_STORY.md)
- Example transcript: [demo-outputs/remote-handoff-transcript.txt](./docs/demo-outputs/remote-handoff-transcript.txt)
- Capability backend status: [Capability Backends](./docs/CAPABILITY_BACKENDS.md)
