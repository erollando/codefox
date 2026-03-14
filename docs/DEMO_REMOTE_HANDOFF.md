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
