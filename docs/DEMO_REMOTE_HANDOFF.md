# Demo: Desk-to-Pocket Continuation

## Chosen idea
`Invoice Export Release Handoff`

Story:
- A developer is working in VS Code with an external Codex client.
- Code is partially done, but approval + final regression still remain.
- The user leaves the desk and continues from phone through CodeFox.

Goal:
- Show CodeFox as authority for approvals, policy, and audit while enabling seamless continuation.

## Handoff steps (desk -> phone)

1. Start CodeFox (`npm run dev`).
2. In Telegram, open the target session route by setting repo and mode (example: `/repo payments-api`, `/mode active`).
3. Prepare/approve the spec in CodeFox (`/spec draft ...`, `/spec clarify ...`, `/spec approve`).
4. External client binds to that active session route with a lease (`POST /v1/external-codex/bind`), usually done by the plugin/skill.
5. External client reports progress/approval/completion (`POST /v1/external-codex/event`).
6. At handoff time, external client sends the typed handoff bundle (`POST /v1/external-codex/handoff`).
7. CodeFox confirms handoff readiness in the chat; user continues from phone with `/handoff show` and `/handoff continue <work-id>`.

If CodeFox is started late:
- It still works if steps 2-4 happen before step 6.
- Earlier desk-side progress is not present in CodeFox history.

## How external bind works (concrete)

Prerequisites:
- `externalRelay.enabled` is `true` in CodeFox config.
- If auth is enabled, use `Authorization: Bearer <token>` on relay requests.
- A Telegram session route already exists (repo + mode selected in chat).

1. External client discovers active routes:

```bash
curl -s http://127.0.0.1:8787/v1/external-codex/routes
```

Example response:

```json
{
  "ok": true,
  "routes": [
    { "sessionId": "chat:100/repo:payments-api/mode:active", "chatId": 100 }
  ]
}
```

2. External client binds to one `sessionId`:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/external-codex/bind \
  -H 'content-type: application/json' \
  -d '{
    "clientId": "vscode-codex-demo",
    "session": { "sessionId": "chat:100/repo:payments-api/mode:active" },
    "requestedSchemaVersion": "v1",
    "requestedCapabilityClasses": ["progress", "approval_request", "completion", "handoff_bundle"],
    "requestedLeaseSeconds": 600
  }'
```

3. CodeFox returns a lease:

```json
{
  "ok": true,
  "lease": {
    "leaseId": "lease_...",
    "clientId": "vscode-codex-demo",
    "session": { "sessionId": "chat:100/repo:payments-api/mode:active" },
    "schemaVersion": "v1",
    "capabilityClasses": ["progress", "approval_request", "completion", "handoff_bundle"],
    "createdAt": "...",
    "lastHeartbeatAt": "...",
    "expiresAt": "..."
  },
  "manifest": {
    "schemaVersion": "v1",
    "capabilityClasses": ["progress", "blocker", "approval_request", "completion", "handoff_bundle"],
    "maxLeaseSeconds": 600
  }
}
```

From this point:
- Send events with `POST /v1/external-codex/event` using that `leaseId`.
- Send handoff with `POST /v1/external-codex/handoff` using that `leaseId`.
- Optionally refresh with `POST /v1/external-codex/heartbeat`.
- Revoke with `POST /v1/external-codex/revoke` when done.

## What you do in VS Code

At the desk, your external client (plugin/skill) should expose this flow:

1. Attach to CodeFox session
- Choose the target session route (for example `chat:100/repo:payments-api/mode:active`).
- Client performs `GET /v1/external-codex/routes` then `POST /v1/external-codex/bind`.

2. Work normally in VS Code
- Keep coding and running steps in the external client.
- Client reports structured updates with `POST /v1/external-codex/event`.
- If CodeFox asks for approval, approve from Telegram (`/approve` or `/deny`).

3. Hand off before leaving desk
- Trigger handoff in client.
- Client sends `POST /v1/external-codex/handoff` with completed work + remaining work.
- CodeFox confirms handoff in chat.

4. Continue from phone
- Run `/handoff show`.
- Run `/handoff continue <work-id>`.

If your current VS Code integration does not automate this yet:
- Use the bridge command instead of raw relay calls:
  - `npm run handoff:cli -- --config ./config/codefox.config.json`
  - Optional overrides: `<chatId>`, `--task <taskId>`, and `--remaining "<summary>"`.

## Real execution (runnable now)

Run:

```bash
npm run demo:remote-handoff
```

This executes a real in-memory scenario through `CodeFoxController` + `ExternalCodexRelay` and prints:
- chat/session setup
- external bind/events/handoff
- approval request resolved through `/approve`
- handoff continued through `/handoff continue`
- explicit command/reply transcript (`USER> ...` + `CODEFOX> ...`)
- audit event counts

Captured run output:
- [remote-handoff-transcript.txt](/home/enrico/git/codefox/docs/demo-outputs/remote-handoff-transcript.txt)

Transcript legend:
- `USER>` command sent from Telegram/mobile
- `CODEFOX>` reply from CodeFox
- `EXTERNAL_CODEX>` attached external client event

## Interaction timeline

1. CodeFox chat setup
- `/repo payments-api`
- `/mode active`
- `/spec draft ...`
- `/spec clarify ...`
- `/spec approve`

2. External Codex attached reporting
- `bind` lease to `chat:100/repo:payments-api/mode:active`
- emit `progress`
- emit `approval_request`

3. CodeFox-owned approval
- user checks `/pending`
- user sends `/approve`
- external approval state becomes `approved`

4. External Codex completion and handoff
- emit `completion`
- emit `handoff` bundle referencing spec revision

5. Remote continuation in CodeFox
- user checks `/handoff show`
- user runs `/handoff continue rw-1`
- CodeFox executes typed remaining work (`repo.run_checks`)

## Command + reply sample

```text
USER> /pending
CODEFOX> Pending approval: extapr_prepare-branch ...

USER> /approve
CODEFOX> Approved external request extapr_prepare-branch.

USER> /handoff show
CODEFOX> External handoff detail: ... remaining work: rw-1 ...

USER> /handoff continue rw-1
CODEFOX> Run completed. ... Executed repo.run_checks ...
```

## What this lets you do

- Start work at your desk and continue from your phone without losing context.
- Keep full control of risky actions: nothing sensitive proceeds without your approval.
- See clear progress updates while work is running in another client.
- Receive a clean handoff with what is done, what is left, and what needs a decision.
- Continue the remaining work in one command (`/handoff continue ...`) instead of restarting from scratch.
- Keep a trace of who approved what and when.
- Read the short version here: [One-Page Story](./DEMO_ONE_PAGE_STORY.md)
