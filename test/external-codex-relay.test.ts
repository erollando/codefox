import { describe, expect, it } from "vitest";
import {
  EXTERNAL_CODEX_SCHEMA_VERSION,
  ExternalCodexIntegration
} from "../src/core/external-codex-integration.js";
import { ExternalCodexRelay } from "../src/core/external-codex-relay.js";

describe("ExternalCodexRelay", () => {
  it("routes accepted external events through CodeFox channels", async () => {
    const auditEvents: Array<Record<string, unknown>> = [];
    const notifications: Array<{ chatId: number; message: string }> = [];
    const approvalCallbacks: Array<Record<string, unknown>> = [];

    const relay = new ExternalCodexRelay({
      integration: new ExternalCodexIntegration(),
      audit: {
        async log(event) {
          auditEvents.push(event);
        }
      },
      notify: async (chatId, message) => {
        notifications.push({ chatId, message });
      },
      onApprovalRequested: async (event) => {
        approvalCallbacks.push(event);
      }
    });

    relay.registerRoute({ sessionId: "chat:100/repo:payments-api/mode:active", chatId: 100 });

    const bind = relay.bind({
      clientId: "vscode-codex",
      session: { sessionId: "chat:100/repo:payments-api/mode:active" },
      requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      requestedCapabilityClasses: ["progress", "approval_request", "completion", "handoff_bundle"]
    });

    expect(bind.ok).toBe(true);
    if (!bind.ok) {
      return;
    }

    await relay.relayEvent({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      eventId: "evt-1",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:00.000Z",
      sequence: 1,
      type: "progress",
      summary: "Running tests",
      progressPercent: 45
    });

    await relay.relayEvent({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      eventId: "evt-2",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:05.000Z",
      sequence: 2,
      type: "approval_request",
      summary: "Need approval before pushing branch",
      approvalKey: "push-branch",
      requestedCapabilityRef: "repo.prepare_branch"
    });

    await relay.relayEvent({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      eventId: "evt-3",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:10.000Z",
      sequence: 3,
      type: "completion",
      status: "success",
      summary: "Execution complete"
    });

    const handoff = await relay.relayHandoff({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      handoffId: "handoff-1",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:11.000Z",
      taskId: "TASK-42",
      specRevisionRef: "v3",
      completedWork: ["Implemented endpoint", "Ran tests"],
      remainingWork: [{ id: "rw-1", summary: "Monitor release" }]
    });

    expect(handoff.ok).toBe(true);
    expect(notifications).toHaveLength(4);
    expect(notifications[0]?.chatId).toBe(100);
    expect(notifications[0]?.message).toContain("progress [45%]");
    expect(notifications[1]?.message).toContain("approval requested");
    expect(notifications[2]?.message).toContain("completion (success)");
    expect(notifications[3]?.message).toContain("handoff bundle received");
    expect(approvalCallbacks).toHaveLength(1);
    expect(approvalCallbacks[0]?.approvalKey).toBe("push-branch");
    expect(auditEvents.some((event) => event.type === "external_event_relayed")).toBe(true);
    expect(auditEvents.some((event) => event.type === "external_handoff_relayed")).toBe(true);
  });

  it("rejects binds and events for unrouted sessions", async () => {
    const auditEvents: Array<Record<string, unknown>> = [];

    const relay = new ExternalCodexRelay({
      integration: new ExternalCodexIntegration(),
      audit: {
        async log(event) {
          auditEvents.push(event);
        }
      },
      notify: async () => {}
    });

    const bind = relay.bind({
      clientId: "vscode-codex",
      session: { sessionId: "unrouted-session" },
      requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      requestedCapabilityClasses: ["progress"]
    });

    expect(bind.ok).toBe(false);
    if (!bind.ok) {
      expect(bind.reasonCode).toBe("invalid_session_id");
    }

    // Bind against a routed session, then remove route before event relay.
    relay.registerRoute({ sessionId: "routed-session", chatId: 100 });
    const validBind = relay.bind({
      clientId: "vscode-codex",
      session: { sessionId: "routed-session" },
      requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      requestedCapabilityClasses: ["progress"]
    });
    expect(validBind.ok).toBe(true);
    if (!validBind.ok) {
      return;
    }

    relay.unregisterRoute("routed-session");
    await relay.relayEvent({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: validBind.lease.leaseId,
      eventId: "evt-1",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:00.000Z",
      sequence: 1,
      type: "progress",
      summary: "still running"
    });

    expect(auditEvents.some((event) => event.type === "external_event_relay_unrouted")).toBe(true);
  });
});
