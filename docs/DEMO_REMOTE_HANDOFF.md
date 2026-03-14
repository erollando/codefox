# Demo: Desk-to-Pocket Continuation (Remote Handoff)

This walkthrough shows a realistic handoff from desk (external Codex client) to phone (CodeFox in Telegram).

If you want only the end-user narrative, read:
- [One-Page Story](./DEMO_ONE_PAGE_STORY.md)

## Scenario

Task: complete and verify an invoice export change.

At the desk, execution starts in an external Codex client.
Before leaving, you hand off remaining work to CodeFox.
From phone, you continue and finish safely.

## Prerequisites

1. CodeFox running:

```bash
npm run dev -- ./config/codefox.config.json
```

2. External relay enabled in config.
3. Telegram session has selected repo and mode.

## End-User Flow (No Raw API Calls)

1. In Telegram (or local REPL), prepare route/spec:

```text
/repo payments-api
/mode active
/spec draft finalize invoice export and regression checks
/spec approve
```

2. From desk terminal, trigger handoff bridge:

```bash
npm run handoff:cli -- --config ./config/codefox.config.json
```

3. Continue from phone:

```text
/handoff show
/continue
# or choose specific item
/continue rw-1
# or index
/continue 2
```

## Integrator Flow (Plugin/Skill)

For plugin/skill implementers, the worker flow is:

1. Discover route: `GET /v1/external-codex/routes`
2. Bind lease: `POST /v1/external-codex/bind`
3. Emit events: `POST /v1/external-codex/event`
4. Submit handoff: `POST /v1/external-codex/handoff`
5. Optional heartbeat/revoke

CodeFox remains authority for policy, approvals, user messaging, and audit.

## Real Runnable Demo

```bash
npm run demo:remote-handoff
```

Output includes a full transcript (`USER>` and `CODEFOX>` lines):
- [remote-handoff-transcript.txt](./demo-outputs/remote-handoff-transcript.txt)

## Expected Outcome

- You can leave the desk and continue from phone without losing task state.
- Approval checkpoints remain explicit.
- Completion replies are concise and always include the request context; `/details` gives full context.

For full command reference and troubleshooting:
- [Manual](./MANUAL.md)
- [Operations Runbook](./OPERATIONS.md)
