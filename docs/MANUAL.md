# CodeFox Manual

Use this page as the index for detailed operational docs.

## By Goal

1. **Install and run CodeFox**
- Read: [OPERATIONS.md](./OPERATIONS.md#start)

2. **Operate day-to-day from Telegram**
- Read: [OPERATIONS.md](./OPERATIONS.md#operational-commands-telegram)

3. **Use local UI / local controls**
- Read: [OPERATIONS.md](./OPERATIONS.md#external-relay-optional)

4. **Use local web UI**
- Start: `npm run ui`
- Open: `http://127.0.0.1:8789`
- Read: [OPERATIONS.md](./OPERATIONS.md#external-relay-optional)

5. **Handoff from external Codex to Telegram**
- Read: [DEMO_HANDOFF.md](./DEMO_HANDOFF.md)
- Desk transcript: [demo-outputs/handoff-transcript.txt](./demo-outputs/handoff-transcript.txt)
- Lifecycle follow-up: [DEMO_HANDOFF_LIFECYCLE.md](./DEMO_HANDOFF_LIFECYCLE.md)
- Lifecycle transcript: [demo-outputs/handoff-lifecycle-transcript.txt](./demo-outputs/handoff-lifecycle-transcript.txt)

6. **Understand the product quickly (end-user view)**
- Read: [DEMO_ONE_PAGE_STORY.md](./DEMO_ONE_PAGE_STORY.md)

7. **Check Codex changelog impact**
- Use: `/codex-changelog`
- Read: [OPERATIONS.md](./OPERATIONS.md#operational-commands-telegram)

## Quick Pointers

- If you only want the shortest path, start with [README.md](../README.md).
- If a run looks too concise, use `/details` for expanded context.
- For relay/handoff issues, use the troubleshooting section in [OPERATIONS.md](./OPERATIONS.md#troubleshooting).

## Local UI Notes

- UI auto-starts CodeFox runtime if it is not already running.
- Default bind is local-only (`127.0.0.1`) for safety.
- For phone/LAN access on trusted networks: `npm run ui -- --host 0.0.0.0 --port 8789`.
- In LAN mode, terminal prints a one-time pair QR/link; scan once from phone to authorize that browser.
- Non-paired remote devices are blocked.
- Mobile mode is automatic on small screens; force with `?mobile=1`.
- Quick actions at the top are the primary interaction controls; transcript area is the main scroll region.
