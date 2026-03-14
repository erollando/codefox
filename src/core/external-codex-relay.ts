import { toAuditPreview } from "./sanitize.js";
import {
  ExternalCodexIntegration,
  type ExternalBindDecision,
  type ExternalBindRequest,
  type ExternalEventDecision,
  type ExternalCodexEvent,
  type ExternalCodexHandoffBundle,
  type ExternalHandoffDecision,
  type ExternalBindingLease
} from "./external-codex-integration.js";

export interface ExternalRelayAuditSink {
  log(event: Record<string, unknown>): Promise<void>;
}

export interface ExternalCodexRelayOptions {
  integration?: ExternalCodexIntegration;
  audit: ExternalRelayAuditSink;
  notify: (chatId: number, message: string) => Promise<void>;
  onApprovalRequested?: (event: {
    leaseId: string;
    chatId: number;
    approvalKey: string;
    summary: string;
    requestedCapabilityRef?: string;
  }) => Promise<void>;
  onHandoffReceived?: (event: {
    leaseId: string;
    sessionId: string;
    chatId: number;
    handoff: ExternalCodexHandoffBundle;
  }) => Promise<void>;
}

export interface ExternalRouteEntry {
  sessionId: string;
  chatId: number;
}

export type ExternalApprovalStatus = "pending" | "approved" | "denied";

export interface ExternalApprovalRecord {
  leaseId: string;
  approvalKey: string;
  chatId: number;
  clientId: string;
  summary: string;
  requestedCapabilityRef?: string;
  status: ExternalApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedByUserId?: number;
}

export interface ExternalRelayEventResult {
  decision: ExternalEventDecision;
  relayed: boolean;
}

export interface ExternalRelayHandoffResult {
  decision: ExternalHandoffDecision;
  relayed: boolean;
}

export class ExternalCodexRelay {
  readonly integration: ExternalCodexIntegration;
  private readonly routes = new Map<string, ExternalRouteEntry>();
  private readonly approvals = new Map<string, ExternalApprovalRecord>();

  constructor(private readonly options: ExternalCodexRelayOptions) {
    this.integration = options.integration ?? new ExternalCodexIntegration();
  }

  registerRoute(entry: ExternalRouteEntry): void {
    this.routes.set(entry.sessionId, entry);
  }

  unregisterRoute(sessionId: string): void {
    this.routes.delete(sessionId);
  }

  setRoutes(entries: ExternalRouteEntry[]): void {
    this.routes.clear();
    for (const entry of entries) {
      this.routes.set(entry.sessionId, entry);
    }
  }

  listRoutes(): ExternalRouteEntry[] {
    return [...this.routes.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  bind(request: ExternalBindRequest): ExternalBindDecision {
    const route = this.routes.get(request.session.sessionId);
    if (!route) {
      return {
        ok: false,
        reasonCode: "invalid_session_id",
        reason: `Session '${request.session.sessionId}' is not routed for external relay integration.`,
        manifest: this.integration.getManifest()
      };
    }
    return this.integration.bind(request);
  }

  heartbeatLease(leaseId: string): boolean {
    return this.integration.heartbeat(leaseId);
  }

  revokeLease(leaseId: string, reason?: string): boolean {
    const revoked = this.integration.revokeLease(leaseId, reason);
    if (!revoked) {
      return false;
    }
    for (const [key, record] of this.approvals.entries()) {
      if (record.leaseId === leaseId) {
        this.approvals.delete(key);
      }
    }
    return true;
  }

  async relayEvent(event: ExternalCodexEvent): Promise<ExternalRelayEventResult> {
    const decision = this.integration.acceptEvent(event);
    if (!decision.ok) {
      await this.options.audit.log({
        type: "external_event_relay_rejected",
        leaseId: event.leaseId,
        clientId: event.clientId,
        eventType: event.type,
        eventId: event.eventId,
        reasonCode: decision.reasonCode,
        reason: decision.reason
      });
      return { decision, relayed: false };
    }

    const route = this.routes.get(decision.lease.session.sessionId);
    if (!route) {
      await this.options.audit.log({
        type: "external_event_relay_unrouted",
        leaseId: event.leaseId,
        clientId: event.clientId,
        sessionId: decision.lease.session.sessionId,
        eventType: event.type,
        eventId: event.eventId
      });
      return { decision, relayed: false };
    }

    await this.options.audit.log({
      type: "external_event_relayed",
      leaseId: event.leaseId,
      clientId: event.clientId,
      sessionId: decision.lease.session.sessionId,
      chatId: route.chatId,
      eventType: event.type,
      eventId: event.eventId,
      summaryPreview: toAuditPreview(event.summary, 200)
    });

    const message = formatEventRelayMessage(decision.lease.session.sessionId, event);
    await this.options.notify(route.chatId, message);

    if (event.type === "approval_request") {
      this.approvals.set(approvalRecordKey(event.leaseId, event.approvalKey), {
        leaseId: event.leaseId,
        approvalKey: event.approvalKey,
        chatId: route.chatId,
        clientId: event.clientId,
        summary: event.summary,
        requestedCapabilityRef: event.requestedCapabilityRef,
        status: "pending",
        createdAt: event.timestamp
      });
      if (this.options.onApprovalRequested) {
        await this.options.onApprovalRequested({
          leaseId: event.leaseId,
          chatId: route.chatId,
          approvalKey: event.approvalKey,
          summary: event.summary,
          requestedCapabilityRef: event.requestedCapabilityRef
        });
      }
    }
    return { decision, relayed: true };
  }

  async relayHandoff(handoff: ExternalCodexHandoffBundle): Promise<ExternalRelayHandoffResult> {
    const decision = this.integration.acceptHandoff(handoff);
    if (!decision.ok) {
      await this.options.audit.log({
        type: "external_handoff_relay_rejected",
        leaseId: handoff.leaseId,
        clientId: handoff.clientId,
        handoffId: handoff.handoffId,
        reasonCode: decision.reasonCode,
        reason: decision.reason
      });
      return { decision, relayed: false };
    }

    const route = this.routes.get(decision.lease.session.sessionId);
    if (!route) {
      await this.options.audit.log({
        type: "external_handoff_relay_unrouted",
        leaseId: handoff.leaseId,
        clientId: handoff.clientId,
        sessionId: decision.lease.session.sessionId,
        handoffId: handoff.handoffId
      });
      return { decision, relayed: false };
    }

    await this.options.audit.log({
      type: "external_handoff_relayed",
      leaseId: handoff.leaseId,
      clientId: handoff.clientId,
      handoffId: handoff.handoffId,
      sessionId: decision.lease.session.sessionId,
      chatId: route.chatId,
      taskId: handoff.taskId,
      remainingWorkCount: handoff.remainingWork.length
    });

    await this.options.notify(route.chatId, formatHandoffRelayMessage(decision.lease.session.sessionId, handoff));
    if (this.options.onHandoffReceived) {
      await this.options.onHandoffReceived({
        leaseId: handoff.leaseId,
        sessionId: decision.lease.session.sessionId,
        chatId: route.chatId,
        handoff
      });
    }
    return { decision, relayed: true };
  }

  resolveLease(leaseId: string): ExternalBindingLease | undefined {
    return this.integration.listLeases().find((lease) => lease.leaseId === leaseId);
  }

  getApprovalDecision(leaseId: string, approvalKey: string): ExternalApprovalRecord | undefined {
    const record = this.approvals.get(approvalRecordKey(leaseId, approvalKey));
    return record ? { ...record } : undefined;
  }

  async decideApproval(
    leaseId: string,
    approvalKey: string,
    approved: boolean,
    decidedByUserId: number
  ): Promise<ExternalApprovalRecord | undefined> {
    const key = approvalRecordKey(leaseId, approvalKey);
    const record = this.approvals.get(key);
    if (!record || record.status !== "pending") {
      return undefined;
    }

    const decisionStatus: ExternalApprovalStatus = approved ? "approved" : "denied";
    const decidedAt = new Date().toISOString();
    const decided: ExternalApprovalRecord = {
      ...record,
      status: decisionStatus,
      decidedAt,
      decidedByUserId
    };
    this.approvals.set(key, decided);
    await this.options.audit.log({
      type: "external_approval_decided",
      leaseId,
      approvalKey,
      chatId: record.chatId,
      status: decisionStatus,
      decidedByUserId,
      decidedAt
    });
    return { ...decided };
  }
}

function formatEventRelayMessage(sessionId: string, event: ExternalCodexEvent): string {
  const prefix = "External Codex";
  if (event.type === "progress") {
    const percent = typeof event.progressPercent === "number" ? ` [${event.progressPercent}%]` : "";
    return `${prefix} progress${percent}: ${event.summary}`;
  }
  if (event.type === "blocker") {
    const inputNeeded = event.needsUserInput ? "yes" : "no";
    return `${prefix} blocker (${event.blockerCode}, needs input: ${inputNeeded}): ${event.summary}`;
  }
  if (event.type === "approval_request") {
    return `${prefix} approval requested (${event.approvalKey}${event.requestedCapabilityRef ? `, ${event.requestedCapabilityRef}` : ""}): ${event.summary}`;
  }
  return `${prefix} completion (${event.status}): ${event.summary}`;
}

function formatHandoffRelayMessage(_sessionId: string, handoff: ExternalCodexHandoffBundle): string {
  return [
    "External Codex handoff bundle received:",
    `task: ${handoff.taskId}`,
    `spec ref: ${handoff.specRevisionRef}`,
    `completed work: ${handoff.completedWork.length}`,
    `remaining work: ${handoff.remainingWork.length}`
  ].join("\n");
}

function approvalRecordKey(leaseId: string, approvalKey: string): string {
  return `${leaseId}:${approvalKey}`;
}
