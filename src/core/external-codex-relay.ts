import { toAuditPreview } from "./sanitize.js";
import {
  ExternalCodexIntegration,
  type ExternalBindDecision,
  type ExternalBindRequest,
  type ExternalCodexEvent,
  type ExternalCodexHandoffBundle,
  type ExternalHandoffDecision
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
}

export interface ExternalRouteEntry {
  sessionId: string;
  chatId: number;
}

export class ExternalCodexRelay {
  readonly integration: ExternalCodexIntegration;
  private readonly routes = new Map<string, ExternalRouteEntry>();

  constructor(private readonly options: ExternalCodexRelayOptions) {
    this.integration = options.integration ?? new ExternalCodexIntegration();
  }

  registerRoute(entry: ExternalRouteEntry): void {
    this.routes.set(entry.sessionId, entry);
  }

  unregisterRoute(sessionId: string): void {
    this.routes.delete(sessionId);
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

  async relayEvent(event: ExternalCodexEvent): Promise<void> {
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
      return;
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
      return;
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

    if (event.type === "approval_request" && this.options.onApprovalRequested) {
      await this.options.onApprovalRequested({
        leaseId: event.leaseId,
        chatId: route.chatId,
        approvalKey: event.approvalKey,
        summary: event.summary,
        requestedCapabilityRef: event.requestedCapabilityRef
      });
    }
  }

  async relayHandoff(handoff: ExternalCodexHandoffBundle): Promise<ExternalHandoffDecision> {
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
      return decision;
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
      return decision;
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
    return decision;
  }
}

function formatEventRelayMessage(sessionId: string, event: ExternalCodexEvent): string {
  const prefix = `External Codex (${sessionId})`;
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

function formatHandoffRelayMessage(sessionId: string, handoff: ExternalCodexHandoffBundle): string {
  return [
    `External Codex (${sessionId}) handoff bundle received:`,
    `task: ${handoff.taskId}`,
    `spec ref: ${handoff.specRevisionRef}`,
    `completed work: ${handoff.completedWork.length}`,
    `remaining work: ${handoff.remainingWork.length}`
  ].join("\n");
}
