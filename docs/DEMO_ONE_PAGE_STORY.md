# One-Page Story: Continue Developer Work From Phone

You are implementing a feature in VS Code with an external Codex client.

You finish most of the work, but before release you still need:
- one approval for a sensitive step,
- one final regression check,
- and a clear status update.

Then you leave your desk.

With CodeFox, you do not lose the session.

Handoff steps:

1. Start CodeFox (`npm run dev`).
2. In Telegram, set the target route (`/repo ...`, `/mode ...`) and approve the spec (`/spec ...`).
3. External VS Code client binds to that session route (`POST /v1/external-codex/bind`) and reports events.
4. During work, CodeFox asks for approvals; you approve from phone (`/approve`) when needed.
5. External client sends handoff bundle (`POST /v1/external-codex/handoff`).
6. CodeFox confirms handoff is ready.
7. On phone, run `/handoff show`, then `/handoff continue rw-1`.

You can start CodeFox from the beginning, or start it before handoff.

In VS Code, your external client action is simple:
- attach to CodeFox session,
- work as usual while reporting progress,
- trigger handoff when you leave the desk.
- if integration is not automated yet, run one bridge command (`npm run handoff:cli -- ...`) instead of manual relay API calls.

Command + reply transcript:

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

What you get:

- Continuity: no restart, no copy/paste handoff, no lost context.
- Control: approvals stay in your channel, not in the external client.
- Safety: policy gates still apply before any continuation run.
- Clarity: progress, blockers, approvals, and completion are visible.
- Traceability: every important action is auditable.

In short:

CodeFox lets you move between desk and phone while keeping work structured, controlled, and finishable.
