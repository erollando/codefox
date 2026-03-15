# Demo: Handoff Lifecycle

This walkthrough shows what happens after a handoff bundle reaches CodeFox: approval prompts, handoff ingest, acceptance, waiting for external completion, and auto-continuation.

If you want the actual desk-side handoff action, read:
- [Demo: Handoff](./DEMO_HANDOFF.md)

## Scenario

Task: complete and verify an invoice export change.

At the desk, the external Codex client is already bound to the relay and has started reporting progress.
This demo begins after that desk-side setup and focuses on the relay/controller lifecycle inside CodeFox.

## Real Runnable Demo

```bash
npm run demo:handoff-lifecycle
```

Output includes a full transcript (`USER>`, `CODEFOX>`, and `EXTERNAL_CODEX>` lines):
- [handoff-lifecycle-transcript.txt](./demo-outputs/handoff-lifecycle-transcript.txt)

## What It Demonstrates

- External progress and approval events entering CodeFox
- Handoff bundle ingest
- `/accept`
- waiting state while the external client is still running
- later external `completion`
- automatic CodeFox continuation from stored handoff context

## What It Does Not Demonstrate

- running `npm run handoff:cli` from the desk terminal
- missing-relay startup behavior (`[F/b/N]`, foreground vs background)
- the operator's terminal output during handoff submission
- true same-thread takeover of the original external Codex session

For those, use the desk-side demo:
- [Demo: Handoff](./DEMO_HANDOFF.md)
