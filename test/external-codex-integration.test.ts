import { describe, expect, it } from "vitest";
import {
  EXTERNAL_CODEX_SCHEMA_VERSION,
  ExternalCodexIntegration,
  type ExternalCodexHandoffBundle,
  type ExternalCodexProgressEvent
} from "../src/core/external-codex-integration.js";

describe("ExternalCodexIntegration", () => {
  it("grants lease binds and accepts typed stage-1 events", () => {
    const audits: Array<Record<string, unknown>> = [];
    const nowMs = Date.parse("2026-03-14T12:00:00.000Z");
    const integration = new ExternalCodexIntegration({
      now: () => new Date(nowMs),
      onAuditEvent: (event) => {
        audits.push(event);
      }
    });

    const bind = integration.bind({
      clientId: "vscode-codex",
      session: { sessionId: "chat:100/repo:payments-api/mode:active" },
      requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      requestedCapabilityClasses: ["progress", "approval_request", "completion", "handoff_bundle"],
      requestedLeaseSeconds: 120
    });

    expect(bind.ok).toBe(true);
    if (!bind.ok) {
      return;
    }

    const progress: ExternalCodexProgressEvent = {
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      eventId: "evt-1",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:05.000Z",
      sequence: 1,
      type: "progress",
      summary: "Running integration tests",
      progressPercent: 30
    };

    const progressDecision = integration.acceptEvent(progress);
    expect(progressDecision.ok).toBe(true);

    const completionDecision = integration.acceptEvent({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      eventId: "evt-2",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:12.000Z",
      sequence: 2,
      type: "completion",
      status: "success",
      summary: "Execution phase complete"
    });
    expect(completionDecision.ok).toBe(true);

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      handoffId: "handoff-1",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:13.000Z",
      taskId: "TASK-123",
      specRevisionRef: "v3",
      completedWork: ["Implemented API endpoint", "Ran tests"],
      remainingWork: [{ id: "rw-1", summary: "Monitor rollout", blockedByApproval: true }],
      evidenceRefs: ["artifact://test-report"]
    };

    const handoffDecision = integration.acceptHandoff(handoff);
    expect(handoffDecision.ok).toBe(true);
    expect(audits.some((event) => event.type === "external_bind_granted")).toBe(true);
    expect(audits.some((event) => event.type === "external_event_accepted")).toBe(true);
    expect(audits.some((event) => event.type === "external_handoff_accepted")).toBe(true);
  });

  it("rejects invalid binds and stale event sequencing", () => {
    const integration = new ExternalCodexIntegration({
      manifest: {
        schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
        capabilityClasses: ["progress", "completion"],
        maxLeaseSeconds: 60
      }
    });

    const unsupportedCapabilityBind = integration.bind({
      clientId: "vscode-codex",
      session: { sessionId: "session-1" },
      requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      requestedCapabilityClasses: ["progress", "approval_request"]
    });
    expect(unsupportedCapabilityBind.ok).toBe(false);
    if (unsupportedCapabilityBind.ok) {
      return;
    }
    expect(unsupportedCapabilityBind.reasonCode).toBe("unsupported_capability_class");

    const bind = integration.bind({
      clientId: "vscode-codex",
      session: { sessionId: "session-2" },
      requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      requestedCapabilityClasses: ["progress", "completion"]
    });
    expect(bind.ok).toBe(true);
    if (!bind.ok) {
      return;
    }

    const first = integration.acceptEvent({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      eventId: "evt-1",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:05.000Z",
      sequence: 1,
      type: "progress",
      summary: "running"
    });
    expect(first.ok).toBe(true);

    const stale = integration.acceptEvent({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      eventId: "evt-2",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:06.000Z",
      sequence: 1,
      type: "progress",
      summary: "duplicate"
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reasonCode).toBe("out_of_order_sequence");
    }
  });

  it("expires leases and rejects events after expiry", () => {
    let nowMs = Date.parse("2026-03-14T12:00:00.000Z");
    const integration = new ExternalCodexIntegration({
      now: () => new Date(nowMs),
      manifest: {
        schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
        capabilityClasses: ["progress", "completion"],
        maxLeaseSeconds: 10
      }
    });

    const bind = integration.bind({
      clientId: "vscode-codex",
      session: { sessionId: "session-timeout" },
      requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      requestedCapabilityClasses: ["progress"],
      requestedLeaseSeconds: 5
    });

    expect(bind.ok).toBe(true);
    if (!bind.ok) {
      return;
    }

    nowMs = Date.parse("2026-03-14T12:00:06.000Z");
    const decision = integration.acceptEvent({
      schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
      leaseId: bind.lease.leaseId,
      eventId: "evt-1",
      clientId: "vscode-codex",
      timestamp: "2026-03-14T12:00:06.000Z",
      sequence: 1,
      type: "progress",
      summary: "after expiry"
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reasonCode).toBe("lease_expired");
    }
    expect(integration.listLeases().length).toBe(0);
  });
});
