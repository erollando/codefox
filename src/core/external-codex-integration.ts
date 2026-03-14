import { randomBytes } from "node:crypto";

export const EXTERNAL_CODEX_SCHEMA_VERSION = "v1" as const;

export type ExternalCodexSchemaVersion = typeof EXTERNAL_CODEX_SCHEMA_VERSION;

export type ExternalCapabilityClass =
  | "progress"
  | "blocker"
  | "approval_request"
  | "completion"
  | "handoff_bundle";

export interface ExternalSessionBindingRef {
  sessionId: string;
}

export interface ExternalCapabilityManifest {
  schemaVersion: ExternalCodexSchemaVersion;
  capabilityClasses: ExternalCapabilityClass[];
  maxLeaseSeconds: number;
}

export interface ExternalBindRequest {
  clientId: string;
  session: ExternalSessionBindingRef;
  requestedSchemaVersion: ExternalCodexSchemaVersion;
  requestedCapabilityClasses: ExternalCapabilityClass[];
  requestedLeaseSeconds?: number;
}

export interface ExternalBindingLease {
  leaseId: string;
  clientId: string;
  session: ExternalSessionBindingRef;
  schemaVersion: ExternalCodexSchemaVersion;
  capabilityClasses: ExternalCapabilityClass[];
  createdAt: string;
  expiresAt: string;
  lastHeartbeatAt: string;
}

export interface ExternalIntegrationAuditEvent {
  type:
    | "external_bind_granted"
    | "external_bind_denied"
    | "external_lease_heartbeat"
    | "external_lease_revoked"
    | "external_event_accepted"
    | "external_event_rejected"
    | "external_handoff_accepted"
    | "external_handoff_rejected"
    | "external_lease_expired";
  [key: string]: unknown;
}

export type ExternalBindDecision =
  | {
      ok: true;
      lease: ExternalBindingLease;
      manifest: ExternalCapabilityManifest;
    }
  | {
      ok: false;
      reasonCode:
        | "invalid_client_id"
        | "invalid_session_id"
        | "unsupported_schema_version"
        | "unsupported_capability_class"
        | "invalid_requested_lease_seconds";
      reason: string;
      manifest: ExternalCapabilityManifest;
    };

interface ExternalLeaseRecord {
  lease: ExternalBindingLease;
  lastSequence: number;
}

export interface ExternalCodexProgressEvent {
  schemaVersion: ExternalCodexSchemaVersion;
  leaseId: string;
  eventId: string;
  clientId: string;
  timestamp: string;
  sequence: number;
  type: "progress";
  summary: string;
  progressPercent?: number;
  evidenceRefs?: string[];
}

export interface ExternalCodexBlockerEvent {
  schemaVersion: ExternalCodexSchemaVersion;
  leaseId: string;
  eventId: string;
  clientId: string;
  timestamp: string;
  sequence: number;
  type: "blocker";
  summary: string;
  blockerCode: string;
  needsUserInput: boolean;
}

export interface ExternalCodexApprovalRequestEvent {
  schemaVersion: ExternalCodexSchemaVersion;
  leaseId: string;
  eventId: string;
  clientId: string;
  timestamp: string;
  sequence: number;
  type: "approval_request";
  summary: string;
  approvalKey: string;
  requestedCapabilityRef?: string;
}

export interface ExternalCodexCompletionEvent {
  schemaVersion: ExternalCodexSchemaVersion;
  leaseId: string;
  eventId: string;
  clientId: string;
  timestamp: string;
  sequence: number;
  type: "completion";
  status: "success" | "failed" | "aborted";
  summary: string;
  evidenceRefs?: string[];
}

export type ExternalCodexEvent =
  | ExternalCodexProgressEvent
  | ExternalCodexBlockerEvent
  | ExternalCodexApprovalRequestEvent
  | ExternalCodexCompletionEvent;

export interface ExternalHandoffRemainingWorkItem {
  id: string;
  summary: string;
  requestedCapabilityRef?: string;
  blockedByApproval?: boolean;
}

export interface ExternalCodexHandoffBundle {
  schemaVersion: ExternalCodexSchemaVersion;
  leaseId: string;
  handoffId: string;
  clientId: string;
  createdAt: string;
  taskId: string;
  specRevisionRef: string;
  completedWork: string[];
  remainingWork: ExternalHandoffRemainingWorkItem[];
  evidenceRefs?: string[];
  unresolvedQuestions?: string[];
  unresolvedRisks?: string[];
}

export type ExternalEventDecision =
  | {
      ok: true;
      lease: ExternalBindingLease;
      event: ExternalCodexEvent;
    }
  | {
      ok: false;
      reasonCode:
        | "unknown_lease"
        | "lease_expired"
        | "client_mismatch"
        | "schema_mismatch"
        | "out_of_order_sequence"
        | "unsupported_event_type"
        | "missing_required_field"
        | "invalid_timestamp"
        | "invalid_progress_percent";
      reason: string;
    };

export type ExternalHandoffDecision =
  | {
      ok: true;
      lease: ExternalBindingLease;
      handoff: ExternalCodexHandoffBundle;
    }
  | {
      ok: false;
      reasonCode:
        | "unknown_lease"
        | "lease_expired"
        | "client_mismatch"
        | "schema_mismatch"
        | "missing_required_field"
        | "invalid_timestamp"
        | "unsupported_capability_class";
      reason: string;
    };

export interface ExternalCodexIntegrationOptions {
  manifest?: ExternalCapabilityManifest;
  now?: () => Date;
  onAuditEvent?: (event: ExternalIntegrationAuditEvent) => void | Promise<void>;
}

const DEFAULT_MANIFEST: ExternalCapabilityManifest = {
  schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
  capabilityClasses: ["progress", "blocker", "approval_request", "completion", "handoff_bundle"],
  maxLeaseSeconds: 600
};

export class ExternalCodexIntegration {
  private readonly manifest: ExternalCapabilityManifest;
  private readonly now: () => Date;
  private readonly leases = new Map<string, ExternalLeaseRecord>();

  constructor(private readonly options: ExternalCodexIntegrationOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.manifest = options.manifest ?? DEFAULT_MANIFEST;
  }

  getManifest(): ExternalCapabilityManifest {
    return {
      schemaVersion: this.manifest.schemaVersion,
      capabilityClasses: [...this.manifest.capabilityClasses],
      maxLeaseSeconds: this.manifest.maxLeaseSeconds
    };
  }

  bind(request: ExternalBindRequest): ExternalBindDecision {
    if (!request.clientId || request.clientId.trim().length === 0) {
      return this.rejectBind("invalid_client_id", "Client id is required.");
    }
    if (!request.session.sessionId || request.session.sessionId.trim().length === 0) {
      return this.rejectBind("invalid_session_id", "Session id is required.");
    }
    if (request.requestedSchemaVersion !== this.manifest.schemaVersion) {
      return this.rejectBind(
        "unsupported_schema_version",
        `Unsupported schema version '${request.requestedSchemaVersion}'.`
      );
    }

    for (const capabilityClass of request.requestedCapabilityClasses) {
      if (!this.manifest.capabilityClasses.includes(capabilityClass)) {
        return this.rejectBind(
          "unsupported_capability_class",
          `Capability class '${capabilityClass}' is not supported by this CodeFox instance.`
        );
      }
    }

    const requestedLeaseSeconds = request.requestedLeaseSeconds ?? this.manifest.maxLeaseSeconds;
    if (!Number.isInteger(requestedLeaseSeconds) || requestedLeaseSeconds <= 0) {
      return this.rejectBind("invalid_requested_lease_seconds", "Requested lease seconds must be a positive integer.");
    }

    const boundedLeaseSeconds = Math.min(requestedLeaseSeconds, this.manifest.maxLeaseSeconds);
    const now = this.now();
    const lease: ExternalBindingLease = {
      leaseId: `lease_${randomHex(8)}`,
      clientId: request.clientId.trim(),
      session: {
        sessionId: request.session.sessionId.trim()
      },
      schemaVersion: this.manifest.schemaVersion,
      capabilityClasses: [...request.requestedCapabilityClasses],
      createdAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + boundedLeaseSeconds * 1000).toISOString()
    };

    this.leases.set(lease.leaseId, { lease, lastSequence: 0 });
    this.emitAudit({
      type: "external_bind_granted",
      leaseId: lease.leaseId,
      clientId: lease.clientId,
      sessionId: lease.session.sessionId,
      capabilityClasses: lease.capabilityClasses,
      expiresAt: lease.expiresAt
    });

    return {
      ok: true,
      lease,
      manifest: this.getManifest()
    };
  }

  heartbeat(leaseId: string): boolean {
    const record = this.leases.get(leaseId);
    if (!record || this.isExpired(record.lease)) {
      return false;
    }

    const now = this.now();
    record.lease.lastHeartbeatAt = now.toISOString();
    record.lease.expiresAt = new Date(now.getTime() + this.manifest.maxLeaseSeconds * 1000).toISOString();
    this.emitAudit({
      type: "external_lease_heartbeat",
      leaseId,
      clientId: record.lease.clientId,
      expiresAt: record.lease.expiresAt
    });
    return true;
  }

  revokeLease(leaseId: string, reason?: string): boolean {
    const record = this.leases.get(leaseId);
    if (!record) {
      return false;
    }
    this.leases.delete(leaseId);
    this.emitAudit({
      type: "external_lease_revoked",
      leaseId,
      clientId: record.lease.clientId,
      reason: reason ?? "manual_revoke"
    });
    return true;
  }

  acceptEvent(event: ExternalCodexEvent): ExternalEventDecision {
    const record = this.leases.get(event.leaseId);
    if (!record) {
      return this.rejectEvent(event, "unknown_lease", `Lease '${event.leaseId}' was not found.`);
    }
    if (this.isExpired(record.lease)) {
      this.leases.delete(event.leaseId);
      this.emitAudit({
        type: "external_lease_expired",
        leaseId: event.leaseId,
        clientId: record.lease.clientId
      });
      return this.rejectEvent(event, "lease_expired", `Lease '${event.leaseId}' has expired.`);
    }
    if (event.clientId !== record.lease.clientId) {
      return this.rejectEvent(event, "client_mismatch", "Event client id does not match lease owner.");
    }
    if (event.schemaVersion !== record.lease.schemaVersion) {
      return this.rejectEvent(event, "schema_mismatch", "Event schema version does not match lease schema version.");
    }
    if (!isValidIsoTimestamp(event.timestamp)) {
      return this.rejectEvent(event, "invalid_timestamp", "Event timestamp is not a valid ISO-8601 string.");
    }
    if (event.sequence <= record.lastSequence) {
      return this.rejectEvent(event, "out_of_order_sequence", "Event sequence is stale or duplicated.");
    }
    if (!record.lease.capabilityClasses.includes(event.type)) {
      return this.rejectEvent(event, "unsupported_event_type", `Lease does not allow event type '${event.type}'.`);
    }
    if (!event.eventId || !event.summary) {
      return this.rejectEvent(event, "missing_required_field", "Event requires non-empty eventId and summary.");
    }
    if (event.type === "progress") {
      if (
        typeof event.progressPercent !== "undefined" &&
        (!Number.isFinite(event.progressPercent) || event.progressPercent < 0 || event.progressPercent > 100)
      ) {
        return this.rejectEvent(event, "invalid_progress_percent", "Progress percent must be between 0 and 100.");
      }
    }
    if (event.type === "blocker" && !event.blockerCode) {
      return this.rejectEvent(event, "missing_required_field", "Blocker events require blockerCode.");
    }
    if (event.type === "approval_request" && !event.approvalKey) {
      return this.rejectEvent(event, "missing_required_field", "Approval request events require approvalKey.");
    }

    record.lastSequence = event.sequence;
    this.emitAudit({
      type: "external_event_accepted",
      leaseId: event.leaseId,
      clientId: event.clientId,
      eventType: event.type,
      eventId: event.eventId,
      sequence: event.sequence
    });

    return {
      ok: true,
      lease: cloneLease(record.lease),
      event
    };
  }

  acceptHandoff(handoff: ExternalCodexHandoffBundle): ExternalHandoffDecision {
    const record = this.leases.get(handoff.leaseId);
    if (!record) {
      return this.rejectHandoff(handoff, "unknown_lease", `Lease '${handoff.leaseId}' was not found.`);
    }
    if (this.isExpired(record.lease)) {
      this.leases.delete(handoff.leaseId);
      this.emitAudit({
        type: "external_lease_expired",
        leaseId: handoff.leaseId,
        clientId: record.lease.clientId
      });
      return this.rejectHandoff(handoff, "lease_expired", `Lease '${handoff.leaseId}' has expired.`);
    }
    if (handoff.clientId !== record.lease.clientId) {
      return this.rejectHandoff(handoff, "client_mismatch", "Handoff client id does not match lease owner.");
    }
    if (handoff.schemaVersion !== record.lease.schemaVersion) {
      return this.rejectHandoff(
        handoff,
        "schema_mismatch",
        "Handoff schema version does not match lease schema version."
      );
    }
    if (!record.lease.capabilityClasses.includes("handoff_bundle")) {
      return this.rejectHandoff(
        handoff,
        "unsupported_capability_class",
        "Lease does not allow continuation handoff bundles."
      );
    }
    if (!handoff.handoffId || !handoff.taskId || !handoff.specRevisionRef) {
      return this.rejectHandoff(handoff, "missing_required_field", "Handoff requires handoffId, taskId, and specRevisionRef.");
    }
    if (!isValidIsoTimestamp(handoff.createdAt)) {
      return this.rejectHandoff(handoff, "invalid_timestamp", "Handoff timestamp is not a valid ISO-8601 string.");
    }

    this.emitAudit({
      type: "external_handoff_accepted",
      leaseId: handoff.leaseId,
      clientId: handoff.clientId,
      handoffId: handoff.handoffId,
      taskId: handoff.taskId,
      remainingWorkCount: handoff.remainingWork.length
    });

    return {
      ok: true,
      lease: cloneLease(record.lease),
      handoff
    };
  }

  listLeases(): ExternalBindingLease[] {
    return [...this.leases.values()].map((record) => cloneLease(record.lease));
  }

  pruneExpiredLeases(): string[] {
    const expiredLeaseIds: string[] = [];
    for (const [leaseId, record] of this.leases.entries()) {
      if (!this.isExpired(record.lease)) {
        continue;
      }
      this.leases.delete(leaseId);
      expiredLeaseIds.push(leaseId);
      this.emitAudit({
        type: "external_lease_expired",
        leaseId,
        clientId: record.lease.clientId
      });
    }
    return expiredLeaseIds;
  }

  private rejectBind(reasonCode: Extract<ExternalBindDecision, { ok: false }>['reasonCode'], reason: string): ExternalBindDecision {
    this.emitAudit({
      type: "external_bind_denied",
      reasonCode,
      reason
    });
    return {
      ok: false,
      reasonCode,
      reason,
      manifest: this.getManifest()
    };
  }

  private rejectEvent(
    event: ExternalCodexEvent,
    reasonCode: Extract<ExternalEventDecision, { ok: false }>['reasonCode'],
    reason: string
  ): ExternalEventDecision {
    this.emitAudit({
      type: "external_event_rejected",
      leaseId: event.leaseId,
      clientId: event.clientId,
      eventType: event.type,
      eventId: event.eventId,
      reasonCode,
      reason
    });
    return {
      ok: false,
      reasonCode,
      reason
    };
  }

  private rejectHandoff(
    handoff: ExternalCodexHandoffBundle,
    reasonCode: Extract<ExternalHandoffDecision, { ok: false }>['reasonCode'],
    reason: string
  ): ExternalHandoffDecision {
    this.emitAudit({
      type: "external_handoff_rejected",
      leaseId: handoff.leaseId,
      clientId: handoff.clientId,
      handoffId: handoff.handoffId,
      reasonCode,
      reason
    });
    return {
      ok: false,
      reasonCode,
      reason
    };
  }

  private isExpired(lease: ExternalBindingLease): boolean {
    const expiresAtMs = Date.parse(lease.expiresAt);
    return !Number.isFinite(expiresAtMs) || expiresAtMs <= this.now().getTime();
  }

  private emitAudit(event: ExternalIntegrationAuditEvent): void {
    if (!this.options.onAuditEvent) {
      return;
    }
    const maybePromise = this.options.onAuditEvent(event);
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
      void (maybePromise as Promise<void>).catch((error) => {
        console.error(`Failed to handle external integration audit event: ${String(error)}`);
      });
    }
  }
}

function cloneLease(lease: ExternalBindingLease): ExternalBindingLease {
  return {
    ...lease,
    session: {
      sessionId: lease.session.sessionId
    },
    capabilityClasses: [...lease.capabilityClasses]
  };
}

function isValidIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
