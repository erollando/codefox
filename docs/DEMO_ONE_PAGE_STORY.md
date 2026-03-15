# One-Page Story: Continue Work From Phone

You are working in an external Codex client at your desk.

You implemented most of a task, but still need:
- one approval,
- one final check,
- and a clean completion note.

Then you leave your desk.

CodeFox keeps the work moving from your phone.

## What You Do

1. Start CodeFox.
2. In Telegram, set repo/mode and approve the spec.
3. Trigger handoff from desk.
4. From phone, tap `Accept handoff`.
5. If desk Codex is still running, CodeFox waits and starts its own continuation when desk execution finishes.

## Transcript (Command + Reply)

```text
USER> /repo payments-api
CODEFOX> Repo set to payments-api.

USER> /mode active
CODEFOX> Mode set to active (workspace-write sandbox).

USER> /spec draft finalize invoice export and release checks
CODEFOX> Spec draft created (v1 interpreted).

USER> /spec approve
CODEFOX> Approved spec v1.

USER> /pending
CODEFOX> Pending approval: extapr_prepare-branch ...

USER> /approve
CODEFOX> Approved external request extapr_prepare-branch.

CODEFOX> Accept handoff? External Codex is still running. CodeFox will wait and start its own continuation when it finishes.
USER> Accept handoff
CODEFOX> Accepted handoff handoff_1. External Codex is still running. CodeFox will start its own continuation automatically when it finishes.

CODEFOX> External Codex finished (success) for handoff handoff_1. Starting CodeFox continuation now.
CODEFOX> Working on your request in payments-api (active).

CODEFOX> Completed: Ran regression checks and prepared release note draft.
CODEFOX> request: Continue remaining work from desk session ...
CODEFOX> Next: use /details for full context.
```

## What You Get

- Continuity: task/spec/handoff context carries over; the first CodeFox continuation starts in CodeFox's own Codex session lifecycle, then follow-up `/continue` or `/steer` reuses that CodeFox thread.
- Control: approvals remain in CodeFox channels.
- Safety: policy and mode still gate execution.
- Clarity: updates are concise; `/details` gives full context.

For full setup + exact operator steps:
- [Demo: Handoff](./DEMO_HANDOFF.md)
- [Demo: Handoff Lifecycle](./DEMO_HANDOFF_LIFECYCLE.md)
- [Manual](./MANUAL.md)
