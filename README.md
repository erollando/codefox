# CodeFox

**Secure remote developer delegation.**

CodeFox is a control plane for Codex work: you can start locally, continue remotely, and keep approvals, policy, and audit in one place.

## What You Get

- One shared session state across Telegram, the local UI, and local admin commands.
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
/codex-changelog
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
Remote scope note: in CodeFox today, "remote" (internet) UI means Telegram. LAN/browser control is handled by the local web UI.

Local rule: slash-prefixed input is for CodeFox control. Plain text is forwarded to Codex as work/steer input.

### External Handoff (Desk -> Telegram)

Prerequisite: `externalRelay.enabled=true` in `config/codefox.config.json`.

At desk:

```bash
npm run handoff:cli
```

If CodeFox is not already running, the handoff CLI now prompts before starting it. Interactive default is foreground, so the terminal stays attached to `npm run dev` and `Ctrl+C` stops it cleanly. Use `--start-in-background` only when you explicitly want a detached process. The legacy `--start-if-missing` flag remains as a compatibility alias for background start.

Then from Telegram/UI:

```text
/accept
```

Handoff behavior: after a handoff arrives, Telegram/UI shows `/accept`, `/reject`, and `/handoff show`. If the external client is still running, CodeFox waits for the external completion signal and then starts its own continuation automatically. If the external client already finished, accepting starts that continuation immediately. Acceptance does not attach to or reclaim the original external Codex thread. CodeFox only takes ownership of the handoff state and any later CodeFox-managed continuation run. Today, external handoff continuity is task/spec/repo context continuity; same-thread takeover would require the external client to provide a resumable Codex thread/session id.

## Operational Helpers

```bash
npm run dev:stop
```

## Trust Boundary

CodeFox is the authority for policy, approvals, communication, and audit. External workers execute within that boundary.

![CodeFox Trust Boundary](./docs/assets/trust-boundary.svg)

## Current Limits

- Capability packs exist as policy contracts; only `jira` is currently marked as native-backed (`implemented`).
- Runtime behavior can depend on installed Codex CLI version.

## Documentation

- Start/operate/troubleshoot: [Manual](./docs/MANUAL.md)
- Desk-side handoff action: [Demo: Handoff](./docs/DEMO_HANDOFF.md)
- Relay/controller follow-up: [Demo: Handoff Lifecycle](./docs/DEMO_HANDOFF_LIFECYCLE.md)
- End-user narrative: [Demo: One-Page Story](./docs/DEMO_ONE_PAGE_STORY.md)
- Desk transcript: [demo-outputs/handoff-transcript.txt](./docs/demo-outputs/handoff-transcript.txt)
- Lifecycle transcript: [demo-outputs/handoff-lifecycle-transcript.txt](./docs/demo-outputs/handoff-lifecycle-transcript.txt)
- Capability backend status: [Capability Backends](./docs/CAPABILITY_BACKENDS.md)
