# One-Page Story: Continue Developer Work From Phone

You are implementing a feature in VS Code with an external Codex client.

You finish most of the work, but before release you still need:
- one approval for a sensitive step,
- one final regression check,
- and a clear status update.

Then you leave your desk.

With CodeFox, you do not lose the session.

When to start:

- Best: start CodeFox at the beginning of work.
- Also valid: start CodeFox before leaving, then bind external client and hand off.

What happens:

1. Your external client reports structured progress into CodeFox.
2. When a sensitive action is needed, CodeFox asks you for approval.
3. You approve from your phone (`/approve`).
4. External execution finishes and sends a handoff bundle.
5. CodeFox shows what is done and what is left (`/handoff show`).
6. You continue the remaining step remotely (`/handoff continue rw-1`).

The handoff itself:

1. In VS Code, external Codex sends a typed handoff bundle to CodeFox.
2. CodeFox confirms handoff is ready.
3. You switch to phone and continue from `/handoff show`.

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
