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
4. Continue from phone with `/handoff` and `/continue`.

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

USER> /handoff show
CODEFOX> Handoff detail: handoff_1 ... remaining work: rw-1 ...

USER> /continue
CODEFOX> Working on your request in payments-api (active).

CODEFOX> Completed: Ran regression checks and prepared release note draft.
CODEFOX> request: Continue remaining work from desk session ...
CODEFOX> Next: use /details for full context.
```

## What You Get

- Continuity: you do not restart or reconstruct context.
- Control: approvals remain in CodeFox channels.
- Safety: policy and mode still gate execution.
- Clarity: updates are concise; `/details` gives full context.

For full setup + exact operator steps:
- [Demo: Remote Handoff](./DEMO_REMOTE_HANDOFF.md)
- [Manual](./MANUAL.md)
