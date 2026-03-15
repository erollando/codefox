# Demo: Handoff

This walkthrough shows the actual desk-side `handoff:cli` action: what you run, what the terminal prints, and what it means for the next Telegram step.
Remote scope note: internet-facing remote control is Telegram; LAN/browser control is the local web UI.

If you want only the end-user narrative, read:
- [One-Page Story](./DEMO_ONE_PAGE_STORY.md)
If you want the post-handoff relay/controller lifecycle, read:
- [Handoff Lifecycle](./DEMO_HANDOFF_LIFECYCLE.md)

## Scenario

Task: complete and verify an invoice export change.

At the desk, execution starts in an external Codex client.
Before leaving, you run `handoff:cli` to submit the handoff into CodeFox.
From phone, you then accept and continue safely.

## Prerequisites

1. CodeFox running:

```bash
npm run dev -- ./config/codefox.config.json
```

2. External relay enabled in config.
3. Telegram session has selected repo and mode.

## Desk-Side Flow

1. In Telegram (or local REPL), prepare route/spec:

```text
/repo payments-api
/mode active
/spec draft finalize invoice export and regression checks
/spec approve
```

2. From the desk terminal, trigger the handoff bridge:

```bash
npm run handoff:cli -- --config ./config/codefox.config.json
```

If CodeFox is not already running, the CLI prompts `[F/b/N]`. Default `F` starts `npm run dev` in the current terminal, submits the handoff once the relay is ready, and then keeps CodeFox attached so you can stop it with `Ctrl+C`. Use `--start-in-background` only if you explicitly want a detached process.

3. After the command succeeds, Telegram shows the handoff prompt. The primary action is:

```text
Accept handoff
```

Because `handoff:cli` is a one-shot bridge, it sends a completion event before the handoff bundle. That means acceptance can continue immediately rather than waiting for a later external completion event.
Acceptance still does not attach to the original external Codex thread. CodeFox continues from the submitted handoff context in its own Codex session lifecycle.

## What The Desk Command Does

- resolves the active route/session
- binds a temporary lease
- sends a `completion` event
- submits the handoff bundle
- revokes the lease

This command transfers task context (spec ref, completed/remaining work, repo metadata), not the desk-side Codex process or its resumable thread/session id.

## Real Runnable Demo

```bash
npm run demo:handoff
```

Output shows the desk command, terminal output, relay calls, and submitted handoff summary:
- [handoff-transcript.txt](./demo-outputs/handoff-transcript.txt)

## Integrator Flow (Plugin/Skill)

For plugin/skill implementers, the worker flow is:

1. Discover route: `GET /v1/external-codex/routes`
2. Bind lease: `POST /v1/external-codex/bind`
3. Emit events: `POST /v1/external-codex/event`
4. Submit handoff bundle: `POST /v1/external-codex/handoff`
5. Keep heartbeat while desk-side execution is still active
6. Emit `completion` when desk-side execution finishes
7. Optional revoke

CodeFox remains authority for policy, approvals, user messaging, and audit.

## Expected Outcome

- You can see exactly what the desk-side handoff command does.
- The terminal output is aligned with the accept-first Telegram flow.
- The operator can distinguish desk-side submission from later continuation lifecycle.

For full command reference and troubleshooting:
- [Manual](./MANUAL.md)
- [Operations Runbook](./OPERATIONS.md)
