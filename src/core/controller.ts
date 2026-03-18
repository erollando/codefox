import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CodexCliAdapter, RunningTask } from "../adapters/codex.js";
import type {
  TelegramAdapter,
  TelegramDocument,
  TelegramPhotoSize,
  TelegramSendOptions,
  TelegramUpdate
} from "../adapters/telegram.js";
import type { AccessControl } from "./auth.js";
import type { AuditEventInput, AuditLogger } from "./audit-logger.js";
import { CapabilityRegistry, toCapabilityRef, type CapabilityActionSpec } from "./capability-registry.js";
import type { CodexChangelogTracker } from "./codex-changelog.js";
import { parseCommand, type ParsedCommand } from "./command-parser.js";
import { areSemanticallyEquivalentExternalHandoffs } from "./external-handoff-idempotency.js";
import type { ApprovalStore } from "./approval-store.js";
import type { PolicyEngine } from "./policy.js";
import type { RepoRegistry } from "./repo-registry.js";
import { toAuditPreview } from "./sanitize.js";
import type { InstructionPolicy } from "./instruction-policy.js";
import { SpecPolicyEngine } from "./spec-policy.js";
import {
  formatApprovalPending,
  formatAuditLookup,
  formatCapabilitiesSummary,
  formatCodexChangelogCheck,
  formatError,
  formatHelp,
  formatMode,
  formatPolicySummary,
  formatPendingApproval,
  formatRepoInfo,
  formatRepos,
  formatSessionStatus,
  formatTaskResult,
  formatTaskStart
} from "./response-formatter.js";
import type { SessionManager } from "./session-manager.js";
import { makeRequestId, makeViewId } from "./ids.js";
import { AGENT_TEMPLATE_NAMES, PLAYBOOK_FILE_NAMES, applyAgentTemplate, applyPlaybookDocs } from "./agent-files.js";
import type { ExternalCodexCompletionEvent, ExternalCodexHandoffBundle } from "./external-codex-integration.js";
import {
  addClarification,
  approveCurrentRevision,
  buildSpecTemplate,
  createInitialWorkflow,
  getCurrentRevision,
  renderLatestDiff,
  renderSpecRevision,
  renderSpecStatus,
  type SpecWorkflowState
} from "./spec-workflow.js";
import type {
  AgentTemplateName,
  CodexReasoningEffort,
  CodexChangelogStateSnapshot,
  ExternalHandoffBundleState,
  ExternalHandoffStateSnapshot,
  PolicyMode,
  RepoConfig,
  RunKind,
  TaskAttachment,
  TaskAttachmentKind,
  TaskContext
} from "../types/domain.js";

interface MessageSink {
  sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<void>;
  downloadFile?(
    fileId: string,
    metadata?: { originalName?: string; mimeType?: string }
  ): Promise<{ localPath: string; originalName?: string; mimeType?: string }>;
}

interface AuditSink {
  log(event: AuditEventInput): Promise<void>;
  findByViewId?(viewId: string): Promise<Record<string, unknown> | undefined>;
}

interface CodexRunner {
  startTask(repoPath: string, context: TaskContext, onProgress?: (line: string) => void | Promise<void>): RunningTask;
}

interface PendingSteer {
  userId: number;
  instruction: string;
  createdAt: string;
  attachments: TaskAttachment[];
}

interface IncomingAttachment {
  kind: TaskAttachmentKind;
  fileId: string;
  originalName?: string;
  mimeType?: string;
}

interface CapabilityAdmissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reasonCode: string;
  reason: string;
}

type AdmissionSource = "run" | "act" | "handoff_continue" | "steer";

interface ExternalHandoffState {
  leaseId: string;
  sourceSessionId?: string;
  sourceRepoName?: string;
  sourceRepoPath?: string;
  sourceMode?: PolicyMode;
  bundle: ExternalCodexHandoffBundle;
  receivedAt: string;
  continuedWorkIds: string[];
  awaitingConfirmation: boolean;
  acceptedAt?: string;
  acceptedByUserId?: number;
  awaitingExternalCompletion: boolean;
  externalCompletionStatus: "pending" | "success" | "failed" | "aborted";
  externalCompletionSummary?: string;
  externalCompletedAt?: string;
}

const SHUTDOWN_ABORT_TIMEOUT_MS = 5000;
const SHUTDOWN_ABORT_POLL_INTERVAL_MS = 50;
const TASK_START_NOTICE_DELAY_MS = 5000;
const SERVICE_STOP_CONFIRM_TTL_MS = 2 * 60 * 1000;
const POLICY_MODES: PolicyMode[] = ["observe", "active", "full-access"];

export interface ControllerShutdownResult {
  abortedRequestIds: string[];
  pendingRequestIds: string[];
}

export interface ControllerDeps {
  telegram: MessageSink;
  access: AccessControl;
  repos: RepoRegistry;
  sessions: SessionManager;
  policy: PolicyEngine;
  approvals: ApprovalStore;
  audit: AuditSink;
  codex: CodexRunner;
  persistRepos?: (repos: RepoConfig[]) => Promise<void>;
  repoInitDefaultParentPath: string;
  initializeRepo?: (repoPath: string) => Promise<void>;
  requireAgentsForRuns: boolean;
  instructionPolicy: InstructionPolicy;
  codexSessionIdleMinutes: number;
  codexDefaultReasoningEffort?: CodexReasoningEffort;
  initialSpecWorkflows?: Array<{ chatId: number; workflow: SpecWorkflowState }>;
  initialExternalHandoffs?: ExternalHandoffStateSnapshot[];
  persistState?: () => Promise<void>;
  specPolicy?: SpecPolicyEngine;
  capabilityRegistry?: CapabilityRegistry;
  codexChangelogTracker?: CodexChangelogTracker;
  initialCodexChangelogState?: CodexChangelogStateSnapshot;
  externalApprovalDecision?: (input: {
    leaseId: string;
    approvalKey: string;
    approved: boolean;
    chatId: number;
    userId: number;
  }) => Promise<boolean>;
  requestServiceStop?: (input: { chatId: number; userId: number }) => Promise<boolean>;
}

export class CodeFoxController {
  private readonly activeAborts = new Map<string, () => void>();
  private readonly steerTriggeredAborts = new Set<string>();
  private readonly executionAdmissionLock = new Set<number>();
  private readonly executionAdmissionSource = new Map<number, AdmissionSource>();
  private readonly pendingSteers = new Map<number, PendingSteer[]>();
  private readonly attachmentContext = new Map<number, TaskAttachment[]>();
  private readonly pendingServiceStopConfirmations = new Map<number, { userId: number; requestedAt: number }>();
  private readonly specDrafts = new Map<number, SpecWorkflowState>();
  private readonly externalHandoffs = new Map<number, ExternalHandoffState>();
  private readonly specPolicy: SpecPolicyEngine;
  private readonly capabilityRegistry: CapabilityRegistry;
  private codexChangelogState?: CodexChangelogStateSnapshot;

  constructor(private readonly deps: ControllerDeps) {
    const rawSendMessage = deps.telegram.sendMessage.bind(deps.telegram);
    deps.telegram.sendMessage = async (chatId, text, options) => {
      const filteredButtons = this.filterTelegramCommandButtons(chatId, options?.commandButtons);
      const buttonsWithHelp = ensureHelpButton(filteredButtons);
      const nextOptions =
        options && typeof options === "object"
          ? {
              ...options,
              commandButtons: buttonsWithHelp
            }
          : { commandButtons: buttonsWithHelp };
      await rawSendMessage(chatId, text, nextOptions);
    };
    this.specPolicy = deps.specPolicy ?? new SpecPolicyEngine();
    this.capabilityRegistry = deps.capabilityRegistry ?? new CapabilityRegistry();
    for (const entry of deps.initialSpecWorkflows ?? []) {
      if (!Number.isSafeInteger(entry.chatId) || entry.workflow.revisions.length === 0) {
        continue;
      }
      this.specDrafts.set(entry.chatId, cloneSpecWorkflow(entry.workflow));
    }
    for (const entry of deps.initialExternalHandoffs ?? []) {
      if (!Number.isSafeInteger(entry.chatId)) {
        continue;
      }
      this.externalHandoffs.set(entry.chatId, {
        leaseId: entry.leaseId,
        sourceSessionId: entry.sourceSessionId,
        sourceRepoName: entry.sourceRepoName,
        sourceRepoPath: entry.sourceRepoPath,
        sourceMode: entry.sourceMode,
        bundle: mapStateBundleToExternalBundle(entry.handoff),
        receivedAt: entry.receivedAt,
        continuedWorkIds: [...entry.continuedWorkIds],
        awaitingConfirmation: entry.awaitingConfirmation === true,
        acceptedAt: entry.acceptedAt,
        acceptedByUserId: entry.acceptedByUserId,
        awaitingExternalCompletion: entry.awaitingExternalCompletion === true,
        externalCompletionStatus:
          entry.externalCompletionStatus ?? (entry.awaitingExternalCompletion === true ? "pending" : "success"),
        externalCompletionSummary: entry.externalCompletionSummary,
        externalCompletedAt: entry.externalCompletedAt
      });
    }
    if (deps.initialCodexChangelogState?.sourceUrl) {
      this.codexChangelogState = {
        ...deps.initialCodexChangelogState,
        seenEntryIds: [...deps.initialCodexChangelogState.seenEntryIds]
      };
    }
  }

  private filterTelegramCommandButtons(chatId: number, buttons?: string[]): string[] | undefined {
    if (!Array.isArray(buttons) || buttons.length === 0) {
      return undefined;
    }
    const session = this.deps.sessions.list().find((entry) => entry.chatId === chatId);
    const activeRequestId = session?.activeRequestId;
    const pendingApproval = this.deps.approvals.get(chatId);
    const handoffState = this.externalHandoffs.get(chatId);
    const pendingServiceStopConfirmation = this.getPendingServiceStopConfirmation(chatId);
    const hasOpenHandoffWork = handoffState ? countOutstandingHandoffWork(handoffState) > 0 : false;
    const handoffActionable = Boolean(
      handoffState && (handoffState.awaitingConfirmation || handoffState.awaitingExternalCompletion || hasOpenHandoffWork)
    );

    const filtered: string[] = [];
    const seen = new Set<string>();
    for (const rawButton of buttons) {
      if (typeof rawButton !== "string") {
        continue;
      }
      const button = rawButton.trim();
      if (!button) {
        continue;
      }
      if (!this.isTelegramButtonRelevant(button, {
        hasPendingApproval: Boolean(pendingApproval),
        hasActiveRequest: Boolean(activeRequestId),
        hasHandoff: Boolean(handoffState),
        handoffActionable,
        handoffAwaitingConfirmation: Boolean(handoffState?.awaitingConfirmation),
        handoffAwaitingExternalCompletion: Boolean(handoffState?.awaitingExternalCompletion),
        hasOpenHandoffWork,
        hasPendingServiceStopConfirmation: Boolean(pendingServiceStopConfirmation)
      })) {
        continue;
      }
      const key = button.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      filtered.push(button);
    }
    return filtered.length > 0 ? filtered : undefined;
  }

  private isTelegramButtonRelevant(
    button: string,
    state: {
      hasPendingApproval: boolean;
      hasActiveRequest: boolean;
      hasHandoff: boolean;
      handoffActionable: boolean;
      handoffAwaitingConfirmation: boolean;
      handoffAwaitingExternalCompletion: boolean;
      hasOpenHandoffWork: boolean;
      hasPendingServiceStopConfirmation: boolean;
    }
  ): boolean {
    const normalized = button.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized === confirmStopButton()) {
      return state.hasPendingServiceStopConfirmation;
    }
    const base = normalized.split(/\s+/)[0];
    if (base === "/approve" || base === "/deny") {
      return state.hasPendingApproval;
    }
    if (base === "/accept" || base === "/reject") {
      return state.handoffAwaitingConfirmation;
    }
    if (base === "/handoff") {
      return state.handoffActionable;
    }
    if (base === "/continue" || base === "/resume") {
      return state.hasHandoff && !state.handoffAwaitingConfirmation && !state.handoffAwaitingExternalCompletion && state.hasOpenHandoffWork;
    }
    if (base === "/abort") {
      return state.hasActiveRequest;
    }
    if (base === "/pending") {
      return state.hasPendingApproval;
    }
    return true;
  }

  listSpecWorkflows(): Array<{ chatId: number; workflow: SpecWorkflowState }> {
    return [...this.specDrafts.entries()]
      .sort(([leftChatId], [rightChatId]) => leftChatId - rightChatId)
      .map(([chatId, workflow]) => ({
        chatId,
        workflow: cloneSpecWorkflow(workflow)
      }));
  }

  listExternalHandoffs(): ExternalHandoffStateSnapshot[] {
    return [...this.externalHandoffs.entries()]
      .sort(([leftChatId], [rightChatId]) => leftChatId - rightChatId)
      .map(([chatId, handoff]) => ({
        chatId,
        leaseId: handoff.leaseId,
        sourceSessionId: handoff.sourceSessionId,
        sourceRepoName: handoff.sourceRepoName,
        sourceRepoPath: handoff.sourceRepoPath,
        sourceMode: handoff.sourceMode,
        handoff: mapExternalBundleToStateBundle(handoff.bundle),
        receivedAt: handoff.receivedAt,
        continuedWorkIds: [...handoff.continuedWorkIds],
        awaitingConfirmation: handoff.awaitingConfirmation,
        acceptedAt: handoff.acceptedAt,
        acceptedByUserId: handoff.acceptedByUserId,
        awaitingExternalCompletion: handoff.awaitingExternalCompletion,
        externalCompletionStatus: handoff.externalCompletionStatus,
        externalCompletionSummary: handoff.externalCompletionSummary,
        externalCompletedAt: handoff.externalCompletedAt
      }));
  }

  getCodexChangelogState(): CodexChangelogStateSnapshot | undefined {
    if (!this.codexChangelogState) {
      return undefined;
    }
    return {
      ...this.codexChangelogState,
      seenEntryIds: [...this.codexChangelogState.seenEntryIds]
    };
  }

  async shutdown(): Promise<ControllerShutdownResult> {
    const active = [...this.activeAborts.entries()];
    if (active.length === 0) {
      return {
        abortedRequestIds: [],
        pendingRequestIds: []
      };
    }

    const startedAtMs = Date.now();
    const abortedRequestIds: string[] = [];

    for (const [requestId, abort] of active) {
      try {
        abort();
        abortedRequestIds.push(requestId);
      } catch (error) {
        await this.deps.audit.log({
          type: "shutdown_abort_error",
          requestId,
          error: String(error)
        });
      }
    }

    const deadlineMs = Date.now() + SHUTDOWN_ABORT_TIMEOUT_MS;
    while (this.activeAborts.size > 0 && Date.now() < deadlineMs) {
      await sleep(SHUTDOWN_ABORT_POLL_INTERVAL_MS);
    }

    const pendingRequestIds = [...this.activeAborts.keys()];
    await this.deps.audit.log({
      type: "shutdown_active_requests",
      abortedRequestIds,
      pendingRequestIds,
      waitMs: Date.now() - startedAtMs
    });

    return {
      abortedRequestIds,
      pendingRequestIds
    };
  }

  async ingestExternalHandoff(
    chatId: number,
    leaseId: string,
    handoff: ExternalCodexHandoffBundle,
    sourceSessionId?: string,
    latestCompletion?: ExternalCodexCompletionEvent
  ): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    await this.bootstrapMissingSpecForExternalHandoff(chatId, leaseId, handoff);
    const specValidation = this.validateHandoffSpecRef(chatId, handoff.specRevisionRef);
    if (!specValidation.accepted) {
      await this.deps.audit.log({
        type: "external_handoff_ingest_rejected",
        chatId,
        leaseId,
        handoffId: handoff.handoffId,
        reason: specValidation.reason
      });
      return specValidation;
    }

    const unresolvedCapabilities: string[] = [];
    const unrunnableCapabilities: string[] = [];
    const sessionMode = this.deps.sessions.getOrCreate(chatId).mode;
    for (const work of handoff.remainingWork) {
      if (!work.requestedCapabilityRef) {
        continue;
      }
      const action = this.capabilityRegistry.resolveAction(work.requestedCapabilityRef);
      if (!action) {
        unresolvedCapabilities.push(work.requestedCapabilityRef);
        continue;
      }
      if (
        !this.capabilityRegistry.isActionRunnableInMode(action, sessionMode) ||
        action.approvalLevel === "local-presence-required"
      ) {
        unrunnableCapabilities.push(work.requestedCapabilityRef);
      }
    }
    if (unresolvedCapabilities.length > 0) {
      const reason = `Unknown requested capability refs: ${[...new Set(unresolvedCapabilities)].join(", ")}`;
      await this.deps.audit.log({
        type: "external_handoff_ingest_rejected",
        chatId,
        leaseId,
        handoffId: handoff.handoffId,
        reason
      });
      return {
        accepted: false,
        reason
      };
    }
    if (unrunnableCapabilities.length > 0) {
      const reason = `Requested capability refs not runnable in mode ${sessionMode}: ${[
        ...new Set(unrunnableCapabilities)
      ].join(", ")}`;
      await this.deps.audit.log({
        type: "external_handoff_ingest_rejected",
        chatId,
        leaseId,
        handoffId: handoff.handoffId,
        reason
      });
      return {
        accepted: false,
        reason
      };
    }

    const existing = this.externalHandoffs.get(chatId);
    if (
      areSemanticallyEquivalentExternalHandoffs(
        existing
          ? {
              sourceSessionId: existing.sourceSessionId,
              bundle: existing.bundle
            }
          : undefined,
        {
          sourceSessionId: sourceSessionId?.trim(),
          bundle: handoff
        }
      )
    ) {
      if (existing && latestCompletion) {
        await this.noteExternalCompletion(chatId, existing.leaseId, latestCompletion, sourceSessionId);
      }
      await this.deps.audit.log({
        type: "external_handoff_ingest_duplicate",
        chatId,
        leaseId,
        handoffId: handoff.handoffId,
        taskId: handoff.taskId
      });
      const duplicateState = this.externalHandoffs.get(chatId);
      if (duplicateState && !latestCompletion && !isActionableHandoffState(duplicateState)) {
        const refreshedState: ExternalHandoffState = {
          leaseId,
          sourceSessionId: sourceSessionId?.trim(),
          sourceRepoName: handoff.sourceRepo?.name?.trim() || parseRepoFromExternalSessionId(sourceSessionId),
          sourceRepoPath: handoff.sourceRepo?.rootPath?.trim() || undefined,
          sourceMode: parseModeFromExternalSessionId(sourceSessionId),
          bundle: cloneExternalHandoffBundle(handoff),
          receivedAt: new Date().toISOString(),
          continuedWorkIds: [],
          awaitingConfirmation: true,
          acceptedAt: undefined,
          acceptedByUserId: undefined,
          awaitingExternalCompletion: false,
          externalCompletionStatus: "success",
          externalCompletionSummary: undefined,
          externalCompletedAt: undefined
        };
        this.externalHandoffs.set(chatId, refreshedState);
        this.persistState();
        await this.deps.telegram.sendMessage(
          chatId,
          [
            `Handoff request received: ${handoff.handoffId}.`,
            "External Codex already finished this step.",
            "Reply with /accept or /reject.",
            "Use /handoff show for details."
          ].join("\n"),
          { commandButtons: buildHandoffConfirmationButtons() }
        );
        return {
          accepted: true
        };
      }
      if (duplicateState && !latestCompletion) {
        if (duplicateState.awaitingConfirmation) {
          await this.deps.telegram.sendMessage(
            chatId,
            [
              `Handoff request still pending: ${duplicateState.bundle.handoffId}.`,
              "Reply with /accept or /reject.",
              "Use /handoff show for details."
            ].join("\n"),
            { commandButtons: buildHandoffConfirmationButtons() }
          );
        } else if (duplicateState.awaitingExternalCompletion) {
          await this.deps.telegram.sendMessage(
            chatId,
            `Handoff ${duplicateState.bundle.handoffId} is accepted and waiting for external completion.`,
            { commandButtons: buildHandoffCommandButtons(duplicateState) }
          );
        } else if (countOutstandingHandoffWork(duplicateState) > 0) {
          await this.deps.telegram.sendMessage(
            chatId,
            `Handoff ${duplicateState.bundle.handoffId} still has pending work. Use /continue or /handoff show.`,
            { commandButtons: buildHandoffCommandButtons(duplicateState) }
          );
        }
      }
      return {
        accepted: true
      };
    }

    this.externalHandoffs.set(chatId, {
      leaseId,
      sourceSessionId: sourceSessionId?.trim(),
      sourceRepoName: handoff.sourceRepo?.name?.trim() || parseRepoFromExternalSessionId(sourceSessionId),
      sourceRepoPath: handoff.sourceRepo?.rootPath?.trim() || undefined,
      sourceMode: parseModeFromExternalSessionId(sourceSessionId),
      bundle: cloneExternalHandoffBundle(handoff),
      receivedAt: new Date().toISOString(),
      continuedWorkIds: [],
      awaitingConfirmation: true,
      acceptedAt: undefined,
      acceptedByUserId: undefined,
      awaitingExternalCompletion: !latestCompletion,
      externalCompletionStatus: latestCompletion?.status ?? "pending",
      externalCompletionSummary: latestCompletion?.summary,
      externalCompletedAt: latestCompletion?.timestamp
    });
    this.persistState();
    await this.deps.audit.log({
      type: "external_handoff_ingested",
      chatId,
      leaseId,
      handoffId: handoff.handoffId,
      taskId: handoff.taskId,
      specRevisionRef: handoff.specRevisionRef,
      remainingWorkCount: handoff.remainingWork.length
    });
    await this.deps.telegram.sendMessage(
      chatId,
      latestCompletion
        ? [
            `Handoff request received: ${handoff.handoffId}.`,
            "External Codex already finished this step.",
            "Reply with /accept or /reject.",
            "Use /handoff show for details."
          ].join("\n")
        : [
            `Handoff request received: ${handoff.handoffId}.`,
            "External Codex is still running.",
            "Reply with /accept or /reject.",
            "Use /handoff show for details."
          ].join("\n"),
      { commandButtons: buildHandoffConfirmationButtons() }
    );
    return {
      accepted: true
    };
  }

  async noteExternalCompletion(
    chatId: number,
    leaseId: string,
    completion: ExternalCodexCompletionEvent,
    sourceSessionId?: string
  ): Promise<void> {
    const state = this.externalHandoffs.get(chatId);
    if (!state || state.leaseId !== leaseId) {
      return;
    }

    const updated: ExternalHandoffState = {
      ...state,
      sourceSessionId: state.sourceSessionId ?? sourceSessionId?.trim(),
      awaitingExternalCompletion: false,
      externalCompletionStatus: completion.status,
      externalCompletionSummary: completion.summary,
      externalCompletedAt: completion.timestamp
    };
    this.externalHandoffs.set(chatId, updated);
    this.persistState();
    await this.deps.audit.log({
      type: "external_handoff_completion_received",
      chatId,
      leaseId,
      handoffId: state.bundle.handoffId,
      taskId: state.bundle.taskId,
      completionStatus: completion.status
    });

    if (updated.awaitingConfirmation) {
        await this.deps.telegram.sendMessage(
          chatId,
          `External Codex finished (${completion.status}) for handoff ${state.bundle.handoffId}. Use /accept to start CodeFox continuation automatically.`,
          { commandButtons: buildHandoffConfirmationButtons() }
        );
      return;
    }

    await this.deps.telegram.sendMessage(
      chatId,
      `External Codex finished (${completion.status}) for handoff ${state.bundle.handoffId}. Starting CodeFox continuation now.`
    );
    await this.autoContinueAcceptedHandoff(chatId, updated.acceptedByUserId ?? 1, updated, "external_completion");
  }

  private async bootstrapMissingSpecForExternalHandoff(
    chatId: number,
    leaseId: string,
    handoff: ExternalCodexHandoffBundle
  ): Promise<void> {
    if (this.specDrafts.has(chatId)) {
      return;
    }
    const match = /^v(\d+)$/i.exec(handoff.specRevisionRef.trim());
    if (!match) {
      return;
    }
    const expectedVersion = Number(match[1]);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return;
    }

    const remainingSummary = handoff.remainingWork[0]?.summary ?? "Continue external handoff work";
    const intent = `Continue ${handoff.taskId}: ${remainingSummary}`;
    let workflow = approveCurrentRevision(createInitialWorkflow(intent));
    if (expectedVersion > 1) {
      const current = getCurrentRevision(workflow);
      const timestamp = new Date().toISOString();
      workflow = {
        revisions: [
          ...workflow.revisions,
          {
            ...current,
            version: expectedVersion,
            stage: "approved",
            status: "approved",
            createdAt: timestamp,
            updatedAt: timestamp,
            approvedAt: timestamp
          }
        ]
      };
    }

    this.specDrafts.set(chatId, workflow);
    this.persistState();
    await this.deps.audit.log({
      type: "external_handoff_spec_bootstrapped",
      chatId,
      leaseId,
      handoffId: handoff.handoffId,
      taskId: handoff.taskId,
      specRevisionRef: handoff.specRevisionRef
    });
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || !message.from) {
      return;
    }

    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
    const incomingAttachments = this.extractIncomingAttachments(message.photo, message.document);

    if (!text && incomingAttachments.length === 0) {
      return;
    }

    try {
      this.deps.access.assertAuthorized({ userId, chatId });
    } catch {
      await this.deps.telegram.sendMessage(chatId, "Unauthorized.");
      return;
    }

    const session = this.deps.sessions.getOrCreate(chatId);
    const command = text ? parseCommand(text) : ({ type: "unknown", raw: "" } as const);
    const downloadedAttachments =
      incomingAttachments.length > 0
        ? await this.downloadIncomingAttachments(chatId, userId, incomingAttachments)
        : [];

    if (!text && downloadedAttachments.length > 0) {
      const existing = this.attachmentContext.get(chatId) ?? [];
      this.attachmentContext.set(chatId, dedupeAttachments([...existing, ...downloadedAttachments]));
    }

    await this.deps.audit.log({
      type: "request_received",
      chatId,
      userId,
      textPreview: toAuditPreview(text),
      textLength: text.length,
      parsedType: text ? command.type : "attachment",
      mode: session.mode,
      repo: session.selectedRepo,
      activeRequestId: session.activeRequestId,
      codexThreadId: session.codexThreadId,
      attachmentCount: downloadedAttachments.length
    });

    if (!text && downloadedAttachments.length > 0) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Attachment received (${downloadedAttachments.length}). Send /run <question> to analyze it.`
      );
      return;
    }

    const pendingHandoff = this.externalHandoffs.get(chatId);
    if (pendingHandoff?.awaitingConfirmation) {
      const decision = parseHandoffConfirmationDecision(text);
      if (decision === "accept") {
        await this.acceptPendingHandoff(chatId, userId, pendingHandoff);
        return;
      }
      if (decision === "reject") {
        await this.rejectPendingHandoff(chatId, userId, pendingHandoff);
        return;
      }
    }

    switch (command.type) {
      case "help": {
        await this.deps.telegram.sendMessage(chatId, formatHelp());
        return;
      }
      case "repos": {
        await this.deps.telegram.sendMessage(chatId, formatRepos(this.deps.repos.list().map((repo) => repo.name)));
        return;
      }
      case "codex_changelog": {
        await this.handleCodexChangelogCheck(chatId, userId);
        return;
      }
      case "capabilities": {
        const currentSession = this.deps.sessions.getOrCreate(chatId);
        const mode = currentSession.mode;
        const actions = command.pack
          ? this.capabilityRegistry.listActions(command.pack)
          : this.capabilityRegistry.listActions();
        await this.deps.audit.log({
          type: "capabilities_viewed",
          chatId,
          userId,
          mode,
          pack: command.pack,
          actionCount: actions.length
        });
        await this.deps.telegram.sendMessage(
          chatId,
          formatCapabilitiesSummary({
            mode,
            pack: command.pack,
            packs: this.capabilityRegistry.listPacks(mode),
            actions
          })
        );
        return;
      }
      case "spec": {
        await this.handleSpecCommand(chatId, userId, command);
        return;
      }
      case "repo": {
        await this.handleRepoSelect(chatId, userId, command.repoName);
        return;
      }
      case "repo_add": {
        await this.handleRepoAdd(chatId, userId, command.repoName, command.repoPath);
        return;
      }
      case "repo_init": {
        await this.handleRepoInit(chatId, userId, command.repoName, command.basePath);
        return;
      }
      case "repo_bootstrap": {
        await this.handleRepoBootstrap(chatId, userId, command.repoName, command.template, command.basePath);
        return;
      }
      case "repo_template": {
        await this.handleRepoTemplate(chatId, userId, command.repoName, command.template);
        return;
      }
      case "repo_playbook": {
        await this.handleRepoPlaybook(chatId, userId, command.repoName, command.overwrite);
        return;
      }
      case "repo_guide": {
        await this.handleRepoGuide(chatId, userId, command.repoName);
        return;
      }
      case "repo_remove": {
        await this.handleRepoRemove(chatId, userId, command.repoName);
        return;
      }
      case "repo_info": {
        const targetName = command.repoName ?? session.selectedRepo;
        if (!targetName) {
          await this.deps.telegram.sendMessage(chatId, "No repo selected. Use /repo <name> or /repo info <name>.");
          return;
        }
        try {
          const repo = this.deps.repos.get(targetName);
          await this.deps.telegram.sendMessage(chatId, formatRepoInfo(repo.name, repo.rootPath));
        } catch (error) {
          await this.deps.telegram.sendMessage(chatId, formatError(String(error)));
        }
        return;
      }
      case "mode": {
        const previousMode = session.mode;
        this.deps.sessions.setMode(chatId, command.mode);
        if (previousMode !== command.mode) {
          this.deps.sessions.clearCodexSession(chatId);
          await this.deps.audit.log({
            type: "codex_session_closed",
            reason: "mode_change",
            chatId,
            userId,
            previousMode,
            nextMode: command.mode
          });
        }
        await this.deps.telegram.sendMessage(chatId, formatMode(command.mode));
        await this.deps.audit.log({ type: "mode_changed", chatId, userId, mode: command.mode });
        return;
      }
      case "reasoning": {
        this.deps.sessions.setReasoningEffortOverride(chatId, command.reasoningEffort);
        await this.deps.telegram.sendMessage(
          chatId,
          command.reasoningEffort
            ? `Reasoning effort set to ${command.reasoningEffort} for this chat.`
            : "Reasoning effort reset to config default for this chat."
        );
        await this.deps.audit.log({
          type: "reasoning_effort_changed",
          chatId,
          userId,
          reasoningEffort: command.reasoningEffort
        });
        return;
      }
      case "policy": {
        const currentSession = this.deps.sessions.getOrCreate(chatId);
        const effectiveMode = command.mode ?? currentSession.mode;
        const viewId = makeViewId();
        const instructionPolicySummary = this.deps.instructionPolicy.summary();
        await this.deps.audit.log({
          type: "policy_viewed",
          viewId,
          chatId,
          userId,
          currentMode: currentSession.mode,
          effectiveMode,
          requireAgentsForRuns: this.deps.requireAgentsForRuns,
          instructionPolicy: instructionPolicySummary
        });
        await this.deps.telegram.sendMessage(
          chatId,
          addAuditRef(
            formatPolicySummary({
              currentMode: currentSession.mode,
              effectiveMode,
              requireAgentsForRuns: this.deps.requireAgentsForRuns,
              instructionPolicy: instructionPolicySummary,
              specPolicies: POLICY_MODES.map((mode) => this.specPolicy.forMode(mode))
            }),
            viewId
          )
        );
        return;
      }
      case "close": {
        await this.handleCloseSession(chatId, userId);
        return;
      }
      case "status": {
        const currentSession = this.deps.sessions.getOrCreate(chatId);
        const handoffState = this.externalHandoffs.get(chatId);
        const pending = this.deps.approvals.get(chatId);
        const viewId = makeViewId();
        await this.deps.audit.log({
          type: "status_viewed",
          viewId,
          chatId,
          userId,
          mode: currentSession.mode,
          repo: currentSession.selectedRepo,
          activeRequestId: currentSession.activeRequestId,
          codexThreadId: currentSession.codexThreadId
        });
        await this.deps.telegram.sendMessage(
          chatId,
          addAuditRef(
            formatSessionStatus(
              currentSession,
              this.deps.codexSessionIdleMinutes,
              this.deps.codexDefaultReasoningEffort,
              this.specPolicy.forMode(currentSession.mode)
            ),
            viewId
          ),
          {
            commandButtons: buildPrimaryCommandButtons(currentSession.activeRequestId, Boolean(pending), handoffState)
          }
        );
        return;
      }
      case "details": {
        const currentSession = this.deps.sessions.getOrCreate(chatId);
        const handoffState = this.externalHandoffs.get(chatId);
        const pending = this.deps.approvals.get(chatId);
        const detailLines = [
          formatSessionStatus(
            currentSession,
            this.deps.codexSessionIdleMinutes,
            this.deps.codexDefaultReasoningEffort,
            this.specPolicy.forMode(currentSession.mode)
          ),
          `pending approval: ${pending?.id ?? "none"}`,
          `external handoff: ${handoffState?.bundle.handoffId ?? "none"}`,
          handoffState ? `handoff remaining: ${countOutstandingHandoffWork(handoffState)}` : ""
        ].filter(Boolean);
        await this.deps.telegram.sendMessage(chatId, detailLines.join("\n"), {
          commandButtons: [showStatusButton(), handoffDetailsButton(), showPendingButton()]
        });
        return;
      }
      case "pending": {
        const pending = this.deps.approvals.get(chatId);
        if (!pending) {
          await this.deps.telegram.sendMessage(
            chatId,
            "No pending approval.\nNext: run /status, or start work with plain text or /run <instruction>.",
            { commandButtons: [showStatusButton(), showDetailsButton()] }
          );
          return;
        }
        await this.deps.telegram.sendMessage(chatId, formatPendingApproval(pending), {
          commandButtons: [approveRequestButton(), denyRequestButton(), showStatusButton()]
        });
        return;
      }
      case "service": {
        await this.handleServiceCommand(chatId, userId, command);
        return;
      }
      case "handoff": {
        await this.handleHandoffCommand(chatId, userId, command);
        return;
      }
      case "handoff_confirmation": {
        const handoffState = this.externalHandoffs.get(chatId);
        if (!handoffState || !handoffState.awaitingConfirmation) {
          await this.deps.telegram.sendMessage(
            chatId,
            "No pending handoff confirmation.\nNext: use /handoff show or /status."
          );
          return;
        }
        if (command.decision === "accept") {
          await this.acceptPendingHandoff(chatId, userId, handoffState);
          return;
        }
        await this.rejectPendingHandoff(chatId, userId, handoffState);
        return;
      }
      case "approve": {
        await this.handleApprove(chatId, userId);
        return;
      }
      case "deny": {
        await this.handleDeny(chatId, userId);
        return;
      }
      case "abort": {
        await this.handleAbort(chatId, userId);
        return;
      }
      case "audit": {
        const event = this.deps.audit.findByViewId ? await this.deps.audit.findByViewId(command.viewId) : undefined;
        await this.deps.audit.log({
          type: "audit_view_lookup",
          chatId,
          userId,
          viewId: command.viewId,
          found: Boolean(event)
        });
        await this.deps.telegram.sendMessage(chatId, formatAuditLookup(command.viewId, event));
        return;
      }
      case "act": {
        const selectedRepo = await this.ensureRepoSelectedForExecution(chatId, userId);
        if (!selectedRepo) {
          return;
        }
        const capabilityAction = this.capabilityRegistry.resolveAction(command.capabilityRef);
        if (!capabilityAction) {
          await this.deps.audit.log({
            type: "capability_policy_block",
            chatId,
            userId,
            mode: session.mode,
            runKind: "run",
            reasonCode: "unknown_capability_action",
            capabilityRef: command.capabilityRef
          });
          await this.deps.telegram.sendMessage(
            chatId,
            `Unknown capability action '${command.capabilityRef}'. Use /capabilities to list available actions.`
          );
          return;
        }

        const attachments = this.resolveAttachmentsForRun(chatId, downloadedAttachments);
        this.runDetached(
          chatId,
          this.executeOrEnqueue({
            runKind: "run",
            admissionSource: "act",
            instruction: command.instruction,
            repoName: selectedRepo,
            mode: session.mode,
            chatId,
            userId,
            attachments,
            capabilityAction
          }),
          "act_execute_or_enqueue"
        );
        return;
      }
      case "run": {
        const isExplicitRunCommand = text.trim().toLowerCase().startsWith("/run");
        if (session.activeRequestId && !isExplicitRunCommand) {
          const attachments = this.resolveAttachmentsForRun(chatId, downloadedAttachments);
          await this.handleSteer(chatId, userId, command.instruction, attachments);
          return;
        }
        if (!isExplicitRunCommand && this.executionAdmissionLock.has(chatId)) {
          const attachments = this.resolveAttachmentsForRun(chatId, downloadedAttachments);
          await this.queueSteerWhileAdmission(chatId, userId, command.instruction, attachments);
          return;
        }
        const selectedRepo = await this.ensureRepoSelectedForExecution(chatId, userId);
        if (!selectedRepo) {
          return;
        }
        const attachments = this.resolveAttachmentsForRun(chatId, downloadedAttachments);
        this.runDetached(
          chatId,
          this.executeOrEnqueue({
            runKind: "run",
            admissionSource: "run",
            instruction: command.instruction,
            repoName: selectedRepo,
            mode: session.mode,
            chatId,
            userId,
            attachments,
            capabilityAction: undefined
          }),
          "run_execute_or_enqueue"
        );
        return;
      }
      case "steer": {
        const attachments = this.resolveAttachmentsForRun(chatId, downloadedAttachments);
        await this.handleSteer(chatId, userId, command.instruction, attachments);
        return;
      }
      default: {
        await this.deps.telegram.sendMessage(
          chatId,
          "Unknown command.\nNext: use /help to see available commands."
        );
      }
    }
  }

  private async handleRepoSelect(chatId: number, userId: number, repoName: string): Promise<void> {
    const session = this.deps.sessions.getOrCreate(chatId);
    if (this.executionAdmissionLock.has(chatId)) {
      await this.sendAdmissionBusyMessage(chatId);
      return;
    }
    if (session.activeRequestId) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Request ${session.activeRequestId} is running. Abort it first with /abort, then switch repo.`
      );
      return;
    }

    try {
      this.deps.repos.get(repoName);
      const previousRepo = session.selectedRepo;
      this.deps.sessions.setRepo(chatId, repoName);

      if (previousRepo && previousRepo !== repoName) {
        this.deps.sessions.clearCodexSession(chatId);
        await this.deps.audit.log({
          type: "codex_session_closed",
          reason: "repo_change",
          chatId,
          userId,
          previousRepo,
          nextRepo: repoName
        });
      }

      await this.deps.telegram.sendMessage(chatId, `Repo set to ${repoName}.`);
      await this.deps.audit.log({ type: "repo_selected", chatId, userId, repo: repoName });
    } catch (error) {
      await this.deps.telegram.sendMessage(chatId, formatError(String(error)));
    }
  }

  private async handleSpecCommand(
    chatId: number,
    userId: number,
    command: Extract<ParsedCommand, { type: "spec" }>
  ): Promise<void> {
    if (command.action === "template") {
      await this.deps.telegram.sendMessage(chatId, buildSpecTemplate());
      return;
    }

    if (command.action === "draft") {
      const workflow = createInitialWorkflow(command.intent ?? "");
      this.specDrafts.set(chatId, workflow);
      this.persistState();
      const currentRevision = getCurrentRevision(workflow);
      const mode = this.deps.sessions.getOrCreate(chatId).mode;
      const missing = this.specPolicy.listMissingSectionsForMode(currentRevision, mode);

      await this.deps.audit.log({
        type: "spec_draft_created",
        chatId,
        userId,
        version: currentRevision.version,
        stage: currentRevision.stage,
        revisionCount: workflow.revisions.length,
        missingRequiredSections: missing
      });
      await this.deps.telegram.sendMessage(
        chatId,
        [
          "Spec lifecycle initialized.",
          "versions: v0(raw), v1(interpreted)",
          `current: v${currentRevision.version} (${currentRevision.stage}, ${currentRevision.status})`,
          `missing sections for mode ${mode}: ${missing.length > 0 ? missing.join(", ") : "(none)"}`,
          "Use /spec clarify <note> to refine.",
          "Use /spec show to review.",
          "Use /spec approve to allow /run."
        ].join("\n")
      );
      return;
    }

    if (command.action === "clarify") {
      const workflow = this.specDrafts.get(chatId);
      if (!workflow) {
        await this.deps.telegram.sendMessage(chatId, "No spec draft. Use /spec draft <intent> first.");
        return;
      }

      const next = addClarification(workflow, command.clarification ?? "");
      this.specDrafts.set(chatId, next);
      this.persistState();
      const currentRevision = getCurrentRevision(next);
      const mode = this.deps.sessions.getOrCreate(chatId).mode;
      const missing = this.specPolicy.listMissingSectionsForMode(currentRevision, mode);

      await this.deps.audit.log({
        type: "spec_clarified",
        chatId,
        userId,
        version: currentRevision.version,
        stage: currentRevision.stage,
        revisionCount: next.revisions.length,
        missingRequiredSections: missing
      });
      await this.deps.telegram.sendMessage(
        chatId,
        [
          `Spec clarified to v${currentRevision.version}.`,
          `current: (${currentRevision.stage}, ${currentRevision.status})`,
          `missing sections for mode ${mode}: ${missing.length > 0 ? missing.join(", ") : "(none)"}`,
          "Use /spec diff to inspect changes."
        ].join("\n")
      );
      return;
    }

    if (command.action === "show") {
      const workflow = this.specDrafts.get(chatId);
      if (!workflow) {
        await this.deps.telegram.sendMessage(chatId, "No spec draft. Use /spec draft <intent> first.");
        return;
      }
      await this.deps.telegram.sendMessage(chatId, renderSpecRevision(getCurrentRevision(workflow)));
      return;
    }

    if (command.action === "status") {
      const workflow = this.specDrafts.get(chatId);
      if (!workflow) {
        await this.deps.telegram.sendMessage(chatId, "Spec status: none. Use /spec draft <intent>.");
        return;
      }
      const mode = this.deps.sessions.getOrCreate(chatId).mode;
      const currentRevision = getCurrentRevision(workflow);
      const missingForMode = this.specPolicy.listMissingSectionsForMode(currentRevision, mode);
      await this.deps.telegram.sendMessage(
        chatId,
        [
          renderSpecStatus(workflow),
          `missing sections for mode ${mode}: ${missingForMode.length > 0 ? missingForMode.join(", ") : "(none)"}`
        ].join("\n")
      );
      return;
    }

    if (command.action === "diff") {
      const workflow = this.specDrafts.get(chatId);
      if (!workflow) {
        await this.deps.telegram.sendMessage(chatId, "No spec draft. Use /spec draft <intent> first.");
        return;
      }
      await this.deps.telegram.sendMessage(chatId, renderLatestDiff(workflow));
      return;
    }

    if (command.action === "approve") {
      const workflow = this.specDrafts.get(chatId);
      if (!workflow) {
        await this.deps.telegram.sendMessage(chatId, "No spec draft to approve. Use /spec draft <intent> first.");
        return;
      }

      const currentRevision = getCurrentRevision(workflow);
      const mode = this.deps.sessions.getOrCreate(chatId).mode;
      const modePolicy = this.specPolicy.forMode(mode);
      const missing = this.specPolicy.listMissingSectionsForMode(currentRevision, mode);
      if (missing.length > 0) {
        if (!modePolicy.allowForceApproval) {
          await this.deps.telegram.sendMessage(
            chatId,
            `Spec v${currentRevision.version} is missing sections required for mode ${mode} (${missing.join(", ")}). Add clarifications before approval.`
          );
          return;
        }
        if (!command.force) {
          await this.deps.telegram.sendMessage(
            chatId,
            `Spec v${currentRevision.version} has missing required sections (${missing.join(", ")}). Use /spec approve force to override in observe mode.`
          );
          return;
        }
      }

      const approved = approveCurrentRevision(workflow);
      this.specDrafts.set(chatId, approved);
      this.persistState();
      const approvedRevision = getCurrentRevision(approved);
      await this.deps.audit.log({
        type: "spec_approved",
        chatId,
        userId,
        version: approvedRevision.version,
        stage: approvedRevision.stage,
        forced: Boolean(command.force),
        mode,
        missingRequiredSections: missing
      });
      await this.deps.telegram.sendMessage(chatId, `Spec v${approvedRevision.version} approved. /run is now allowed.`);
      return;
    }

    if (command.action === "clear") {
      const existingWorkflow = this.specDrafts.get(chatId);
      if (!existingWorkflow) {
        await this.deps.telegram.sendMessage(chatId, "No spec draft to clear.");
        return;
      }
      const existing = getCurrentRevision(existingWorkflow);
      this.specDrafts.delete(chatId);
      this.persistState();
      await this.deps.audit.log({
        type: "spec_cleared",
        chatId,
        userId,
        version: existing.version,
        previousStatus: existing.status
      });
      await this.deps.telegram.sendMessage(chatId, `Spec v${existing.version} cleared.`);
      return;
    }
  }

  private async handleCloseSession(chatId: number, userId: number): Promise<void> {
    const session = this.deps.sessions.getOrCreate(chatId);
    if (session.activeRequestId) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Request ${session.activeRequestId} is running. Abort it first with /abort, then /close.`
      );
      return;
    }

    if (!session.codexThreadId) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No active Codex session to close.\nNext: use /status to inspect session state."
      );
      return;
    }

    const closedThreadId = session.codexThreadId;
    this.deps.sessions.clearCodexSession(chatId);
    await this.deps.audit.log({
      type: "codex_session_closed",
      reason: "explicit_close",
      chatId,
      userId,
      threadId: closedThreadId
    });
    await this.deps.telegram.sendMessage(chatId, `Codex session closed (${closedThreadId}).`);
  }

  private async handleServiceCommand(
    chatId: number,
    userId: number,
    command: Extract<ParsedCommand, { type: "service" }>
  ): Promise<void> {
    if (command.action !== "stop") {
      await this.deps.telegram.sendMessage(chatId, "Unknown service command.");
      return;
    }

    if (!command.confirm) {
      this.pendingServiceStopConfirmations.set(chatId, {
        userId,
        requestedAt: Date.now()
      });
      await this.deps.telegram.sendMessage(
        chatId,
        "Service stop requested.\nNext: confirm with /stopconfirm (or /service stop confirm).",
        { commandButtons: [confirmStopButton(), showStatusButton()] }
      );
      return;
    }

    const pendingConfirmation = this.getPendingServiceStopConfirmation(chatId);
    if (!pendingConfirmation) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No pending service stop confirmation.\nNext: run /service stop first.",
        { commandButtons: [stopServiceButton(), showStatusButton()] }
      );
      return;
    }
    if (pendingConfirmation.userId !== userId) {
      await this.deps.telegram.sendMessage(
        chatId,
        "Only the requesting user can confirm this service stop.",
        { commandButtons: [showStatusButton()] }
      );
      return;
    }
    this.pendingServiceStopConfirmations.delete(chatId);

    if (!this.deps.requestServiceStop) {
      await this.deps.telegram.sendMessage(
        chatId,
        "Service stop is not available in this runtime.\nNext: stop it from host shell with Ctrl+C or npm run dev:stop."
      );
      return;
    }

    const accepted = await this.deps.requestServiceStop({ chatId, userId });
    if (!accepted) {
      await this.deps.telegram.sendMessage(
        chatId,
        "Service stop request was rejected.\nNext: retry in a moment or stop from host shell."
      );
      return;
    }

    await this.deps.audit.log({
      type: "service_stop_requested",
      chatId,
      userId,
      source: "telegram_command"
    });
    await this.deps.telegram.sendMessage(chatId, "Service stop accepted. CodeFox is shutting down.");
  }

  private getPendingServiceStopConfirmation(chatId: number): { userId: number; requestedAt: number } | undefined {
    const pending = this.pendingServiceStopConfirmations.get(chatId);
    if (!pending) {
      return undefined;
    }
    if (Date.now() - pending.requestedAt > SERVICE_STOP_CONFIRM_TTL_MS) {
      this.pendingServiceStopConfirmations.delete(chatId);
      return undefined;
    }
    return pending;
  }

  private async handleApprove(chatId: number, userId: number): Promise<void> {
    const pending = this.deps.approvals.get(chatId);
    if (!pending) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No pending approval.\nNext: use /pending to inspect approval status, or /status for session context."
      );
      return;
    }
    if (pending.userId !== userId) {
      await this.deps.audit.log({
        type: "approval_unauthorized_attempt",
        chatId,
        userId,
        requestId: pending.id,
        pendingOwnerUserId: pending.userId
      });
      await this.deps.telegram.sendMessage(chatId, "Only the requesting user can approve this request.");
      return;
    }

    const session = this.deps.sessions.getOrCreate(chatId);
    if (session.activeRequestId) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Request ${session.activeRequestId} is already running. Use /status or /abort first.`
      );
      return;
    }

    if (pending.externalApproval) {
      const decisionSink = this.deps.externalApprovalDecision;
      if (!decisionSink) {
        await this.deps.telegram.sendMessage(
          chatId,
          "External approval bridge is not configured.\nNext: complete this request from Telegram-only flow or fix relay configuration."
        );
        return;
      }
      const decided = await decisionSink({
        leaseId: pending.externalApproval.leaseId,
        approvalKey: pending.externalApproval.approvalKey,
        approved: true,
        chatId,
        userId
      });
      if (!decided) {
        await this.deps.telegram.sendMessage(
          chatId,
          "External approval request is stale or unknown.\nNext: ask the external client to re-send the approval request."
        );
        return;
      }
      this.deps.approvals.delete(chatId);
      await this.deps.audit.log({
        type: "external_approval_granted",
        chatId,
        userId,
        requestId: pending.id,
        leaseId: pending.externalApproval.leaseId,
        approvalKey: pending.externalApproval.approvalKey
      });
      await this.deps.telegram.sendMessage(chatId, `Approved external request ${pending.id}.`);
      return;
    }

    this.deps.approvals.delete(chatId);
    const capabilityAction = pending.capabilityRef ? this.capabilityRegistry.resolveAction(pending.capabilityRef) : undefined;
    if (!capabilityAction) {
      await this.deps.audit.log({
        type: "capability_policy_block",
        chatId,
        userId,
        mode: pending.mode,
        runKind: "run",
        requestId: pending.id,
        reasonCode: pending.capabilityRef ? "unknown_capability_action" : "capability_required",
        capabilityRef: pending.capabilityRef
      });
      await this.deps.telegram.sendMessage(
        chatId,
        [
          pending.capabilityRef
            ? `Capability policy blocked run: Unknown capability action '${pending.capabilityRef}'.`
            : "Capability policy blocked run: pending approval requires a capability action but none was attached.",
          "Next: retry the original request, or run /act <pack.action> <instruction>."
        ].join("\n")
      );
      return;
    }

    await this.deps.audit.log({
      type: "approval_granted",
      chatId,
      userId,
      requestId: pending.id,
      capabilityRef: toCapabilityRef(capabilityAction)
    });
    this.runDetached(
      chatId,
      this.executeOrEnqueue({
        runKind: "run",
        admissionSource: "act",
        instruction: pending.instruction,
        repoName: pending.repoName,
        mode: pending.mode,
        userId,
        chatId,
        bypassApproval: true,
        attachments: [],
        capabilityAction,
        requestId: pending.id
      }),
      "approve_execute_or_enqueue"
    );
  }

  private async handleDeny(chatId: number, userId: number): Promise<void> {
    const pending = this.deps.approvals.get(chatId);
    if (!pending) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No pending approval.\nNext: use /pending to inspect approval status, or /status for session context."
      );
      return;
    }
    if (pending.userId !== userId) {
      await this.deps.audit.log({
        type: "deny_unauthorized_attempt",
        chatId,
        userId,
        requestId: pending.id,
        pendingOwnerUserId: pending.userId
      });
      await this.deps.telegram.sendMessage(chatId, "Only the requesting user can deny this request.");
      return;
    }

    if (pending.externalApproval) {
      const decisionSink = this.deps.externalApprovalDecision;
      if (!decisionSink) {
        await this.deps.telegram.sendMessage(
          chatId,
          "External approval bridge is not configured.\nNext: complete this request from Telegram-only flow or fix relay configuration."
        );
        return;
      }
      const decided = await decisionSink({
        leaseId: pending.externalApproval.leaseId,
        approvalKey: pending.externalApproval.approvalKey,
        approved: false,
        chatId,
        userId
      });
      if (!decided) {
        await this.deps.telegram.sendMessage(
          chatId,
          "External approval request is stale or unknown.\nNext: ask the external client to re-send the approval request."
        );
        return;
      }
      this.deps.approvals.delete(chatId);
      await this.deps.audit.log({
        type: "external_approval_denied",
        chatId,
        userId,
        requestId: pending.id,
        leaseId: pending.externalApproval.leaseId,
        approvalKey: pending.externalApproval.approvalKey
      });
      await this.deps.telegram.sendMessage(chatId, `Denied external request ${pending.id}.`);
      return;
    }

    this.deps.approvals.delete(chatId);
    await this.deps.audit.log({ type: "approval_denied", chatId, userId, requestId: pending.id });
    await this.deps.telegram.sendMessage(chatId, `Denied request ${pending.id}.`);
  }

  private async acceptPendingHandoff(chatId: number, userId: number, state: ExternalHandoffState): Promise<void> {
    const acceptedAt = new Date().toISOString();
    const acceptedState: ExternalHandoffState = {
      ...state,
      awaitingConfirmation: false,
      acceptedAt,
      acceptedByUserId: userId
    };
    this.externalHandoffs.set(chatId, acceptedState);
    this.persistState();
    await this.deps.audit.log({
      type: "external_handoff_user_accepted",
      chatId,
      userId,
      leaseId: state.leaseId,
      handoffId: state.bundle.handoffId
    });
    if (acceptedState.awaitingExternalCompletion) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Accepted handoff ${state.bundle.handoffId}. External Codex is still running. CodeFox will start its own continuation automatically when it finishes.`,
        { commandButtons: buildHandoffCommandButtons(acceptedState) }
      );
      return;
    }

    await this.deps.telegram.sendMessage(
      chatId,
      `Accepted handoff ${state.bundle.handoffId}. Starting CodeFox continuation now.`,
      { commandButtons: buildHandoffCommandButtons(acceptedState) }
    );
    await this.autoContinueAcceptedHandoff(chatId, userId, acceptedState, "accepted");
  }

  private async rejectPendingHandoff(chatId: number, userId: number, state: ExternalHandoffState): Promise<void> {
    this.externalHandoffs.delete(chatId);
    this.persistState();
    await this.deps.audit.log({
      type: "external_handoff_user_rejected",
      chatId,
      userId,
      leaseId: state.leaseId,
      handoffId: state.bundle.handoffId
    });
    await this.deps.telegram.sendMessage(chatId, `Rejected handoff ${state.bundle.handoffId}.`, {
      commandButtons: [showStatusButton()]
    });
  }

  private async handleHandoffCommand(
    chatId: number,
    userId: number,
    command: Extract<ParsedCommand, { type: "handoff" }>
  ): Promise<void> {
    const state = this.externalHandoffs.get(chatId);
    if (command.action === "clear") {
      if (!state) {
        await this.deps.telegram.sendMessage(
          chatId,
          "No external handoff is currently stored.\nNext: use /status to check the current session."
        );
        return;
      }
      this.externalHandoffs.delete(chatId);
      this.persistState();
      await this.deps.audit.log({
        type: "external_handoff_cleared",
        chatId,
        userId,
        handoffId: state.bundle.handoffId
      });
      await this.deps.telegram.sendMessage(chatId, `Cleared external handoff ${state.bundle.handoffId}.`);
      return;
    }

    if (!state) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No external handoff available.\nNext: run `npm run handoff:cli` from your desk session. When the handoff arrives, use /accept.",
        { commandButtons: [showStatusButton()] }
      );
      return;
    }

    if (command.action === "status") {
      await this.deps.telegram.sendMessage(chatId, formatExternalHandoffStatus(state), {
        commandButtons: buildHandoffCommandButtons(state)
      });
      return;
    }

    if (command.action === "show") {
      await this.deps.telegram.sendMessage(chatId, formatExternalHandoffDetail(state), {
        commandButtons: buildHandoffCommandButtons(state)
      });
      return;
    }
    await this.continueHandoff(chatId, userId, state, command.workId, false);
  }

  private async autoContinueAcceptedHandoff(
    chatId: number,
    userId: number,
    state: ExternalHandoffState,
    reason: "accepted" | "external_completion"
  ): Promise<void> {
    await this.continueHandoff(chatId, userId, state, undefined, true, reason);
  }

  private async continueHandoff(
    chatId: number,
    userId: number,
    inputState: ExternalHandoffState,
    workSelector?: string,
    automatic = false,
    automaticReason?: "accepted" | "external_completion"
  ): Promise<void> {
    let state = inputState;
    if (state.awaitingConfirmation) {
      await this.deps.telegram.sendMessage(
        chatId,
        "This handoff still needs confirmation.\nNext: use /accept or /reject.",
        { commandButtons: buildHandoffConfirmationButtons() }
      );
      return;
    }
    if (state.awaitingExternalCompletion) {
      await this.deps.telegram.sendMessage(
        chatId,
        "External Codex is still running for this handoff.\nNext: wait for completion, or use /handoff show for context.",
        { commandButtons: buildHandoffCommandButtons(state) }
      );
      return;
    }

    const session = this.deps.sessions.getOrCreate(chatId);
    if (state.sourceRepoName && session.selectedRepo !== state.sourceRepoName) {
      const sourceRepoName = state.sourceRepoName;
      if (!this.deps.repos.has(state.sourceRepoName)) {
        if (state.sourceRepoPath) {
          const registeredPath = await this.tryRegisterSourceRepoFromHandoff(
            chatId,
            userId,
            sourceRepoName,
            state.sourceRepoPath
          );
          if (!registeredPath) {
            await this.deps.telegram.sendMessage(
              chatId,
              [
                `Cannot continue handoff ${state.bundle.handoffId}: source repo '${sourceRepoName}' could not be auto-registered from '${state.sourceRepoPath}'.`,
                `Next: use /repo add ${sourceRepoName} <absolute-path>, then /continue.`
              ].join("\n"),
              { commandButtons: buildHandoffCommandButtons(state) }
            );
            return;
          }
          state = {
            ...state,
            sourceRepoPath: registeredPath
          };
          this.externalHandoffs.set(chatId, state);
          this.persistState();
          await this.deps.telegram.sendMessage(
            chatId,
            `Handoff source repo auto-registered: ${sourceRepoName}\npath: ${registeredPath}`
          );
        } else {
          await this.deps.telegram.sendMessage(
            chatId,
            [
              `Cannot continue handoff ${state.bundle.handoffId}: source repo '${sourceRepoName}' is not registered.`,
              `Next: use /repo add ${sourceRepoName} <absolute-path>, then /continue.`
            ].join("\n"),
            { commandButtons: buildHandoffCommandButtons(state) }
          );
          return;
        }
      }
      this.deps.sessions.setRepo(chatId, sourceRepoName);
      this.deps.sessions.clearCodexSession(chatId);
      await this.deps.audit.log({
        type: "external_handoff_repo_aligned",
        chatId,
        userId,
        handoffId: state.bundle.handoffId,
        sourceRepo: sourceRepoName
      });
      await this.deps.telegram.sendMessage(
        chatId,
        `Handoff source repo detected: switched to ${sourceRepoName} for continuation.`
      );
    }

    if (!session.selectedRepo) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No repo selected.\nNext: use /repo <name>, then /continue.",
        { commandButtons: buildHandoffCommandButtons(state) }
      );
      return;
    }

    const specValidation = this.validateHandoffSpecRef(chatId, state.bundle.specRevisionRef);
    if (!specValidation.accepted) {
      await this.deps.telegram.sendMessage(
        chatId,
        [
          `Cannot continue handoff ${state.bundle.handoffId}: ${specValidation.reason}`,
          "Next: use /spec status and /spec approve (or /spec draft if needed), then /continue."
        ].join("\n"),
        { commandButtons: buildHandoffCommandButtons(state) }
      );
      return;
    }

    if (session.activeRequestId) {
      await this.deps.telegram.sendMessage(
        chatId,
        automatic
          ? `External handoff is ready, but request ${session.activeRequestId} is already running.\nNext: use /abort or wait, then /continue.`
          : `Request ${session.activeRequestId} is already running.\nNext: use /status or /abort before continuing the handoff.`,
        { commandButtons: [showStatusButton(), abortRunButton()] }
      );
      return;
    }

    const outstanding = state.bundle.remainingWork.filter((work) => !state.continuedWorkIds.includes(work.id));
    if (outstanding.length === 0) {
      await this.deps.telegram.sendMessage(
        chatId,
        "All handoff work items are already continued.\nNext: use /status, /handoff show, or start a new /run.",
        { commandButtons: [showStatusButton(), handoffDetailsButton()] }
      );
      return;
    }

    const nextWork = workSelector ? resolveOutstandingHandoffWork(outstanding, workSelector) : outstanding[0];
    if (!nextWork) {
      await this.deps.telegram.sendMessage(
        chatId,
        [
          `Work item '${workSelector}' is not available.`,
          "Next: choose one of the pending handoff items.",
          `Choices:\n${renderOutstandingHandoffChoices(outstanding)}`
        ].join("\n"),
        { commandButtons: buildHandoffSelectionCommandButtons(state) }
      );
      return;
    }

    if (!automatic && !workSelector && outstanding.length > 1) {
      const selectedIndex = outstanding.findIndex((work) => work.id === nextWork.id) + 1;
      await this.deps.telegram.sendMessage(
        chatId,
        [
          `Multiple handoff items are pending. Defaulting to ${selectedIndex}: ${nextWork.id} - ${nextWork.summary}`,
          "Next: use /continue 1, /continue 2, or /continue."
        ].join("\n"),
        { commandButtons: buildHandoffSelectionCommandButtons(state) }
      );
    }

    const capabilityAction = nextWork.requestedCapabilityRef
      ? this.capabilityRegistry.resolveAction(nextWork.requestedCapabilityRef)
      : undefined;
    if (nextWork.requestedCapabilityRef && !capabilityAction) {
      await this.deps.telegram.sendMessage(
        chatId,
        [
          `Unknown capability action '${nextWork.requestedCapabilityRef}' for handoff item '${nextWork.id}'.`,
          "Next: review /handoff show and choose a different item."
        ].join("\n"),
        { commandButtons: buildHandoffSelectionCommandButtons(state) }
      );
      await this.deps.audit.log({
        type: "external_handoff_continue_blocked",
        chatId,
        userId,
        handoffId: state.bundle.handoffId,
        workId: nextWork.id,
        reasonCode: "unknown_capability_action",
        capabilityRef: nextWork.requestedCapabilityRef
      });
      return;
    }

    const updatedState: ExternalHandoffState = {
      ...state,
      continuedWorkIds: [...state.continuedWorkIds, nextWork.id]
    };
    this.externalHandoffs.set(chatId, updatedState);
    this.persistState();
    await this.deps.audit.log({
      type: automatic ? "external_handoff_continue_auto_requested" : "external_handoff_continue_requested",
      chatId,
      userId,
      handoffId: state.bundle.handoffId,
      workId: nextWork.id,
      capabilityRef: nextWork.requestedCapabilityRef,
      automaticReason
    });

    this.runDetached(
      chatId,
      this.executeOrEnqueue({
        runKind: "run",
        admissionSource: "handoff_continue",
        instruction: nextWork.summary,
        repoName: session.selectedRepo,
        mode: session.mode,
        userId,
        chatId,
        attachments: [],
        capabilityAction
      }),
      "handoff_continue_execute_or_enqueue"
    );
  }

  private async handleAbort(chatId: number, userId: number): Promise<void> {
    const session = this.deps.sessions.getOrCreate(chatId);
    if (!session.activeRequestId) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No active request.\nNext: start work with plain text or /run <instruction>."
      );
      return;
    }
    const abort = this.activeAborts.get(session.activeRequestId);
    if (!abort) {
      await this.deps.telegram.sendMessage(
        chatId,
        "Active request cannot be aborted right now.\nNext: use /status and retry /abort in a moment."
      );
      return;
    }

    this.pendingSteers.delete(chatId);
    this.steerTriggeredAborts.delete(session.activeRequestId);
    abort();
    await this.deps.audit.log({
      type: "request_abort",
      chatId,
      userId,
      requestId: session.activeRequestId
    });
    await this.deps.telegram.sendMessage(chatId, `Abort signal sent for ${session.activeRequestId}.`);
  }

  private async handleSteer(
    chatId: number,
    userId: number,
    instruction: string,
    attachments: TaskAttachment[]
  ): Promise<void> {
    const session = this.deps.sessions.getOrCreate(chatId);
    if (!session.selectedRepo) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No repo selected for steer.\nNext: use /repo <name> first."
      );
      return;
    }

    if (!session.activeRequestId) {
      if (this.executionAdmissionLock.has(chatId)) {
        await this.queueSteerWhileAdmission(chatId, userId, instruction, attachments);
        return;
      }
      await this.deps.telegram.sendMessage(
        chatId,
        "No active run to steer.\nNext: start a run with plain text or /run <instruction>."
      );
      return;
    }

    const abort = this.activeAborts.get(session.activeRequestId);
    if (!abort) {
      await this.queueSteerForUninterruptibleRun(chatId, userId, session.activeRequestId, instruction, attachments);
      return;
    }

    const existing = this.pendingSteers.get(chatId) ?? [];
    existing.push({ userId, instruction, createdAt: new Date().toISOString(), attachments });
    this.pendingSteers.set(chatId, existing);

    await this.deps.audit.log({
      type: "steer_received",
      chatId,
      userId,
      requestId: session.activeRequestId,
      steerCount: existing.length,
      instructionPreview: toAuditPreview(instruction)
    });

    if (existing.length === 1) {
      this.steerTriggeredAborts.add(session.activeRequestId);
      abort();
      return;
    }

    await this.deps.telegram.sendMessage(
      chatId,
      `Additional steer captured (${existing.length} pending). Instructions will be merged into the next resume.`
    );
  }

  private async queueSteerForUninterruptibleRun(
    chatId: number,
    userId: number,
    activeRequestId: string,
    instruction: string,
    attachments: TaskAttachment[]
  ): Promise<void> {
    const existing = this.pendingSteers.get(chatId) ?? [];
    existing.push({ userId, instruction, createdAt: new Date().toISOString(), attachments });
    this.pendingSteers.set(chatId, existing);

    await this.deps.audit.log({
      type: "steer_queued_uninterruptible_run",
      chatId,
      userId,
      requestId: activeRequestId,
      steerCount: existing.length,
      instructionPreview: toAuditPreview(instruction)
    });

    await this.deps.telegram.sendMessage(
      chatId,
      `Queued follow-up (${existing.length}) for ${activeRequestId}.\nNext: wait for the current run to finish; CodeFox will apply it automatically.`
    );
  }

  private async queueSteerWhileAdmission(
    chatId: number,
    userId: number,
    instruction: string,
    attachments: TaskAttachment[]
  ): Promise<void> {
    const existing = this.pendingSteers.get(chatId) ?? [];
    existing.push({ userId, instruction, createdAt: new Date().toISOString(), attachments });
    this.pendingSteers.set(chatId, existing);

    const source = this.executionAdmissionSource.get(chatId);
    const sourceLabel = source ? formatAdmissionSource(source).toLowerCase() : "request";
    await this.deps.audit.log({
      type: "steer_queued_waiting_admission",
      chatId,
      userId,
      steerCount: existing.length,
      source,
      instructionPreview: toAuditPreview(instruction)
    });
    await this.deps.telegram.sendMessage(
      chatId,
      `Queued follow-up (${existing.length}) while ${sourceLabel} is being prepared.\nNext: wait for run start; CodeFox will apply it automatically.`
    );
  }

  private async ensureRepoSelectedForExecution(chatId: number, userId: number): Promise<string | undefined> {
    const session = this.deps.sessions.getOrCreate(chatId);
    if (session.selectedRepo) {
      return session.selectedRepo;
    }

    const repos = this.deps.repos.list();
    if (repos.length === 0) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No repo is configured.\nNext: add one with /repo add <name> <absolute-path>, then retry."
      );
      return undefined;
    }

    const preferredRepo = selectPreferredRepoForChat(session.chatId, repos.map((entry) => entry.name), this.deps.sessions.list());
    if (!preferredRepo) {
      await this.deps.telegram.sendMessage(chatId, "Select a repo first with /repo <name>.");
      return undefined;
    }

    this.deps.sessions.setRepo(chatId, preferredRepo);
    await this.deps.audit.log({
      type: "repo_auto_selected_for_run",
      chatId,
      userId,
      repo: preferredRepo
    });

    if (repos.length === 1) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Auto-selected repo '${preferredRepo}' (only configured repo).`
      );
      return preferredRepo;
    }

    const options = repos
      .slice(0, 5)
      .map((repo, index) => `${index + 1}. /repo ${repo.name}`)
      .join("\n");
    await this.deps.telegram.sendMessage(
      chatId,
      [
        `No repo was selected. Defaulted to '${preferredRepo}' from recent context.`,
        "Use /repo <name> to switch.",
        `Options:\n${options}`
      ].join("\n")
    );
    return preferredRepo;
  }

  private async handleRepoAdd(chatId: number, userId: number, repoName: string, repoPath: string): Promise<void> {
    const resolvedPath = path.resolve(repoPath);
    const target = await stat(resolvedPath).catch(() => undefined);
    if (!target || !target.isDirectory()) {
      await this.deps.telegram.sendMessage(
        chatId,
        formatError(`Path does not exist or is not a directory: ${resolvedPath}`)
      );
      return;
    }

    await this.registerRepo(chatId, userId, repoName, resolvedPath, "repo_added");
  }

  private async tryRegisterSourceRepoFromHandoff(
    chatId: number,
    userId: number,
    repoName: string,
    sourceRepoPath: string
  ): Promise<string | undefined> {
    const resolvedPath = path.resolve(sourceRepoPath);
    const target = await stat(resolvedPath).catch(() => undefined);
    if (!target?.isDirectory()) {
      await this.deps.audit.log({
        type: "external_handoff_repo_auto_register_failed",
        chatId,
        userId,
        repo: repoName,
        path: resolvedPath,
        reason: "path_not_directory"
      });
      return undefined;
    }

    const gitRoot = await this.detectGitTopLevel(resolvedPath);
    if (!gitRoot) {
      await this.deps.audit.log({
        type: "external_handoff_repo_auto_register_failed",
        chatId,
        userId,
        repo: repoName,
        path: resolvedPath,
        reason: "not_git_repo"
      });
      return undefined;
    }

    const canonicalPath = path.resolve(gitRoot);
    await this.registerRepo(chatId, userId, repoName, canonicalPath, "repo_added_from_handoff");
    if (!this.deps.repos.has(repoName)) {
      return undefined;
    }
    return canonicalPath;
  }

  private async detectGitTopLevel(repoPath: string): Promise<string | undefined> {
    return await new Promise((resolve) => {
      const child = spawn("git", ["rev-parse", "--show-toplevel"], {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "ignore"]
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.on("error", () => {
        resolve(undefined);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          resolve(undefined);
          return;
        }
        const trimmed = stdout.trim();
        resolve(trimmed.length > 0 ? trimmed : undefined);
      });
    });
  }

  private async handleRepoInit(chatId: number, userId: number, repoName: string, basePathOverride?: string): Promise<void> {
    const parentPath = path.resolve(basePathOverride ?? this.deps.repoInitDefaultParentPath);
    const resolvedPath = path.resolve(parentPath, repoName);
    const existing = await stat(resolvedPath).catch(() => undefined);

    if (existing && !existing.isDirectory()) {
      await this.deps.telegram.sendMessage(
        chatId,
        formatError(`Target path exists but is not a directory: ${resolvedPath}`)
      );
      return;
    }

    if (!existing) {
      await mkdir(resolvedPath, { recursive: true });
    }

    const gitDirPath = path.join(resolvedPath, ".git");
    const gitDir = await stat(gitDirPath).catch(() => undefined);
    if (gitDir && !gitDir.isDirectory()) {
      await this.deps.telegram.sendMessage(
        chatId,
        formatError(`Cannot initialize repository because ${gitDirPath} is not a directory.`)
      );
      return;
    }

    if (!gitDir) {
      try {
        if (this.deps.initializeRepo) {
          await this.deps.initializeRepo(resolvedPath);
        } else {
          await this.initializeRepoDirectory(resolvedPath);
        }
      } catch (error) {
        await this.deps.telegram.sendMessage(
          chatId,
          formatError(`Failed to initialize git repository at ${resolvedPath}: ${String(error)}`)
        );
        return;
      }
    }

    await this.registerRepo(chatId, userId, repoName, resolvedPath, "repo_initialized");
  }

  private async handleRepoBootstrap(
    chatId: number,
    userId: number,
    repoName: string,
    template: AgentTemplateName,
    basePathOverride?: string
  ): Promise<void> {
    if (!AGENT_TEMPLATE_NAMES.includes(template)) {
      await this.deps.telegram.sendMessage(chatId, formatError(`Unknown template '${template}'.`));
      return;
    }

    if (this.deps.repos.has(repoName)) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Repository '${repoName}' already exists. Use /repo template ${repoName} <python|java|nodejs> instead.`
      );
      return;
    }

    await this.handleRepoInit(chatId, userId, repoName, basePathOverride);
    if (!this.deps.repos.has(repoName)) {
      return;
    }
    await this.handleRepoTemplate(chatId, userId, repoName, template);
    await this.handleRepoPlaybook(chatId, userId, repoName, false);
  }

  private async handleRepoTemplate(
    chatId: number,
    userId: number,
    repoName: string,
    template: AgentTemplateName
  ): Promise<void> {
    if (!AGENT_TEMPLATE_NAMES.includes(template)) {
      await this.deps.telegram.sendMessage(chatId, formatError(`Unknown template '${template}'.`));
      return;
    }

    try {
      const repo = this.deps.repos.get(repoName);
      const result = await applyAgentTemplate({
        repoPath: repo.rootPath,
        templateName: template
      });

      await this.deps.audit.log({
        type: "repo_agent_template_applied",
        chatId,
        userId,
        repo: repoName,
        template,
        agentsPath: result.agentsPath,
        wroteAgents: result.written
      });

      await this.deps.telegram.sendMessage(
        chatId,
        [
          `Template applied (${template}) for ${repoName}.`,
          `AGENTS: ${result.written ? "written" : "already present, kept as-is"}`,
          `path: ${result.agentsPath}`
        ].join("\n")
      );
    } catch (error) {
      await this.deps.telegram.sendMessage(chatId, formatError(String(error)));
    }
  }

  private async handleRepoPlaybook(chatId: number, userId: number, repoName: string, overwrite: boolean): Promise<void> {
    try {
      const repo = this.deps.repos.get(repoName);
      const result = await applyPlaybookDocs({
        repoPath: repo.rootPath,
        repoName,
        overwrite
      });

      await this.deps.audit.log({
        type: "repo_playbook_applied",
        chatId,
        userId,
        repo: repoName,
        overwrite,
        writtenFiles: result.written,
        keptFiles: result.kept
      });

      await this.deps.telegram.sendMessage(
        chatId,
        [
          `Playbook scaffold applied for ${repoName}.`,
          `written: ${result.written.length > 0 ? result.written.join(", ") : "(none)"}`,
          `kept: ${result.kept.length > 0 ? result.kept.join(", ") : "(none)"}`,
          !overwrite && result.kept.length > 0 ? `Use /repo playbook ${repoName} overwrite to refresh kept files.` : "",
          "Keep STATUS.md aligned with MILESTONES.md."
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (error) {
      await this.deps.telegram.sendMessage(chatId, formatError(String(error)));
    }
  }

  private async handleRepoGuide(chatId: number, userId: number, repoName?: string): Promise<void> {
    const session = this.deps.sessions.getOrCreate(chatId);
    const targetName = repoName ?? session.selectedRepo;
    if (!targetName) {
      await this.deps.telegram.sendMessage(chatId, "No repo selected. Use /repo <name> or /repo guide <name>.");
      return;
    }

    try {
      const repo = this.deps.repos.get(targetName);
      const allFiles = ["AGENTS.md", ...PLAYBOOK_FILE_NAMES];
      const statuses = await Promise.all(
        allFiles.map(async (fileName) => {
          const filePath = path.join(repo.rootPath, fileName);
          const fileStat = await stat(filePath).catch(() => undefined);
          return {
            fileName,
            present: Boolean(fileStat?.isFile())
          };
        })
      );

      const missing = statuses.filter((entry) => !entry.present).map((entry) => entry.fileName);
      const playbookSet = new Set<string>(PLAYBOOK_FILE_NAMES);
      const presentPlaybook = statuses.filter((entry) => playbookSet.has(entry.fileName) && entry.present).length;
      const missingPlaybook = PLAYBOOK_FILE_NAMES.length - presentPlaybook;
      const hasAgents = statuses.find((entry) => entry.fileName === "AGENTS.md")?.present ?? false;

      await this.deps.audit.log({
        type: "repo_guided",
        chatId,
        userId,
        repo: targetName,
        hasAgents,
        presentPlaybook,
        missingPlaybook,
        missingFiles: missing
      });

      await this.deps.telegram.sendMessage(
        chatId,
        [
          `Repo guidance for ${targetName}`,
          `path: ${repo.rootPath}`,
          `AGENTS.md: ${hasAgents ? "present" : "missing"}`,
          `Playbook docs: ${presentPlaybook}/${PLAYBOOK_FILE_NAMES.length} present`,
          missing.length > 0 ? `Missing: ${missing.join(", ")}` : "Missing: (none)",
          hasAgents ? "" : `Use /repo template ${targetName} <python|java|nodejs> to create AGENTS.md.`,
          missingPlaybook > 0
            ? `Use /repo playbook ${targetName} to create SPEC.md, MILESTONES.md, RUNBOOK.md, VERIFY.md, STATUS.md.`
            : "",
          "Keep STATUS.md milestone progress aligned with MILESTONES.md."
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (error) {
      await this.deps.telegram.sendMessage(chatId, formatError(String(error)));
    }
  }

  private async registerRepo(
    chatId: number,
    userId: number,
    repoName: string,
    resolvedPath: string,
    eventType: "repo_added" | "repo_initialized" | "repo_added_from_handoff"
  ): Promise<void> {
    try {
      const added = this.deps.repos.add({
        name: repoName,
        rootPath: resolvedPath
      });

      if (this.deps.persistRepos) {
        try {
          await this.deps.persistRepos(this.deps.repos.list());
        } catch (persistError) {
          this.deps.repos.remove(added.name);
          await this.deps.telegram.sendMessage(
            chatId,
            formatError(`Repo was validated but persistence failed: ${String(persistError)}`)
          );
          return;
        }
      }

      await this.deps.audit.log({
        type: eventType,
        chatId,
        userId,
        repo: added.name,
        path: added.rootPath
      });
      const prefix =
        eventType === "repo_initialized"
          ? "Repo initialized and added"
          : eventType === "repo_added_from_handoff"
            ? "Repo added from handoff"
            : "Repo added";
      if (eventType === "repo_initialized") {
        this.deps.sessions.setRepo(chatId, added.name);
        this.deps.sessions.clearCodexSession(chatId);
      }
      await this.deps.telegram.sendMessage(
        chatId,
        eventType === "repo_initialized"
          ? `${prefix}: ${added.name}\npath: ${added.rootPath}\nselected: ${added.name}`
          : `${prefix}: ${added.name}\npath: ${added.rootPath}`
      );
    } catch (error) {
      await this.deps.telegram.sendMessage(chatId, formatError(String(error)));
    }
  }

  private async initializeRepoDirectory(repoPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["init"], {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        reject(error);
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`git init exited with code ${code}: ${stderr.trim() || "no stderr output"}`));
      });
    });
  }

  private async handleRepoRemove(chatId: number, userId: number, repoName: string): Promise<void> {
    const session = this.deps.sessions.getOrCreate(chatId);
    if (session.activeRequestId && session.selectedRepo === repoName) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Cannot remove currently active repo '${repoName}' while request ${session.activeRequestId} is running.`
      );
      return;
    }

    try {
      const removed = this.deps.repos.remove(repoName);
      const hadSelectedRepo = session.selectedRepo === repoName;
      if (hadSelectedRepo) {
        this.deps.sessions.clearRepo(chatId);
        this.deps.sessions.clearCodexSession(chatId);
      }

      if (this.deps.persistRepos) {
        try {
          await this.deps.persistRepos(this.deps.repos.list());
        } catch (persistError) {
          this.deps.repos.add(removed);
          if (hadSelectedRepo) {
            this.deps.sessions.setRepo(chatId, removed.name);
          }
          await this.deps.telegram.sendMessage(chatId, formatError(`Repo removal failed to persist: ${String(persistError)}`));
          return;
        }
      }

      await this.deps.audit.log({
        type: "repo_removed",
        chatId,
        userId,
        repo: removed.name,
        path: removed.rootPath
      });
      await this.deps.telegram.sendMessage(chatId, `Repo removed: ${removed.name}`);
    } catch (error) {
      await this.deps.telegram.sendMessage(chatId, formatError(String(error)));
    }
  }

  private extractIncomingAttachments(
    photo?: TelegramPhotoSize[],
    document?: TelegramDocument
  ): IncomingAttachment[] {
    const attachments: IncomingAttachment[] = [];

    if (Array.isArray(photo) && photo.length > 0) {
      const sorted = [...photo].sort((left, right) => {
        const leftScore = (left.file_size ?? 0) || left.width * left.height;
        const rightScore = (right.file_size ?? 0) || right.width * right.height;
        return rightScore - leftScore;
      });
      const selected = sorted[0];
      attachments.push({
        kind: "image",
        fileId: selected.file_id,
        originalName: `photo_${selected.file_id}.jpg`,
        mimeType: "image/jpeg"
      });
    }

    if (document?.file_id) {
      attachments.push({
        kind: isImageMimeType(document.mime_type) ? "image" : "document",
        fileId: document.file_id,
        originalName: document.file_name,
        mimeType: document.mime_type
      });
    }

    return attachments;
  }

  private async downloadIncomingAttachments(
    chatId: number,
    userId: number,
    incoming: IncomingAttachment[]
  ): Promise<TaskAttachment[]> {
    if (incoming.length === 0) {
      return [];
    }

    if (!this.deps.telegram.downloadFile) {
      await this.deps.audit.log({
        type: "attachment_download_unavailable",
        chatId,
        userId,
        attachmentCount: incoming.length
      });
      await this.deps.telegram.sendMessage(
        chatId,
        "Attachment uploads are not enabled for this Telegram adapter. Send text instructions only."
      );
      return [];
    }

    const downloaded: TaskAttachment[] = [];
    for (const attachment of incoming) {
      try {
        const file = await this.deps.telegram.downloadFile(attachment.fileId, {
          originalName: attachment.originalName,
          mimeType: attachment.mimeType
        });
        downloaded.push({
          kind: attachment.kind,
          localPath: file.localPath,
          originalName: file.originalName ?? attachment.originalName,
          mimeType: file.mimeType ?? attachment.mimeType
        });
      } catch (error) {
        await this.deps.audit.log({
          type: "attachment_download_failed",
          chatId,
          userId,
          fileId: attachment.fileId,
          error: String(error)
        });
        await this.deps.telegram.sendMessage(
          chatId,
          formatError(`Failed to download attachment (${attachment.fileId}).`)
        );
      }
    }

    return downloaded;
  }

  private resolveAttachmentsForRun(chatId: number, immediate: TaskAttachment[]): TaskAttachment[] {
    if (immediate.length > 0) {
      return immediate;
    }
    const stored = this.attachmentContext.get(chatId) ?? [];
    this.attachmentContext.delete(chatId);
    return stored;
  }

  private async executeOrEnqueue(params: {
    runKind: RunKind;
    admissionSource: AdmissionSource;
    instruction: string;
    repoName: string;
    mode: PolicyMode;
    chatId: number;
    userId: number;
    bypassApproval?: boolean;
    attachments?: TaskAttachment[];
    capabilityAction?: CapabilityActionSpec;
    requestId?: string;
  }): Promise<void> {
    const { runKind, instruction, repoName, mode, chatId, userId } = params;
    if (this.executionAdmissionLock.has(chatId)) {
      await this.sendAdmissionBusyMessage(chatId);
      return;
    }
    this.executionAdmissionLock.add(chatId);
    this.executionAdmissionSource.set(chatId, params.admissionSource);

    try {
      const session = this.deps.sessions.getOrCreate(chatId);
      if (session.activeRequestId) {
        await this.deps.telegram.sendMessage(
          chatId,
          `Request ${session.activeRequestId} is already running. Use /status or /abort first.`
        );
        return;
      }

      const requestId = params.requestId ?? makeRequestId();
      const capabilityDecision =
        runKind === "run"
          ? this.decideCapabilityAdmission(mode, params.capabilityAction)
          : { allowed: true, requiresApproval: false, reasonCode: "not_applicable", reason: "Steer bypasses capability admission." };

      if (runKind === "run") {
        if (!capabilityDecision.allowed) {
          await this.deps.audit.log({
            type: "capability_policy_block",
            chatId,
            userId,
            repo: repoName,
            mode,
            runKind,
            requestId,
            reasonCode: capabilityDecision.reasonCode,
            capabilityPack: params.capabilityAction?.pack,
            capabilityAction: params.capabilityAction?.action
          });
          await this.deps.telegram.sendMessage(
            chatId,
            [
              `Run blocked by capability policy: ${trimTerminalPunctuation(capabilityDecision.reason)}.`,
              "Next: use /capabilities to inspect allowed actions, or adjust mode with /mode."
            ].join("\n")
          );
          return;
        }

        await this.deps.audit.log({
          type: "capability_policy_decision",
          chatId,
          userId,
          repo: repoName,
          mode,
          runKind,
          requestId,
          requiresApproval: capabilityDecision.requiresApproval,
          reasonCode: capabilityDecision.reasonCode,
          capabilityPack: params.capabilityAction?.pack,
          capabilityAction: params.capabilityAction?.action,
          capabilityRef: params.capabilityAction ? toCapabilityRef(params.capabilityAction) : undefined,
          capabilityRiskLevel: params.capabilityAction?.riskLevel,
          capabilityApprovalLevel: params.capabilityAction?.approvalLevel,
          capabilityExecutionContext: params.capabilityAction?.executionContext
        });
      }

      const instructionDecision = this.deps.instructionPolicy.decide(instruction);
      if (!instructionDecision.allowed) {
        await this.deps.audit.log({
          type: "policy_block_instruction",
          chatId,
          userId,
          repo: repoName,
          mode,
          runKind,
          requestId,
          reason: instructionDecision.reason,
          matchedPattern: instructionDecision.matchedPattern,
          blockedDomain: instructionDecision.blockedDomain,
          blockedPathPattern: instructionDecision.blockedPathPattern
        });
        await this.deps.telegram.sendMessage(
          chatId,
          [
            formatError(
              instructionDecision.blockedDomain
                ? `Instruction references blocked domain: ${instructionDecision.blockedDomain}`
                : instructionDecision.blockedPathPattern
                  ? `Instruction references forbidden path pattern: ${instructionDecision.blockedPathPattern}`
                  : `Instruction blocked by policy (${instructionDecision.matchedPattern ?? "pattern"}).`
            ),
            "Next: remove blocked references and retry."
          ].join("\n")
        );
        return;
      }

      if (mode !== "observe" && this.deps.requireAgentsForRuns) {
        const repo = this.deps.repos.get(repoName);
        const agentsPath = path.join(repo.rootPath, "AGENTS.md");
        const agentsStat = await stat(agentsPath).catch(() => undefined);
        if (!agentsStat || !agentsStat.isFile()) {
          await this.deps.audit.log({
            type: "policy_block_agents_missing",
            chatId,
            userId,
            repo: repoName,
            requestId,
            requiredFile: agentsPath
          });
          await this.deps.telegram.sendMessage(
            chatId,
            `Missing AGENTS.md in repo root (${agentsPath}). Create it before running /run in ${mode} mode.`
          );
          return;
        }
      }

      const decision = this.deps.policy.decide(mode);
      if (!decision.allowed) {
        await this.deps.telegram.sendMessage(
          chatId,
          `${formatError(decision.reason ?? "Run blocked by policy.")}\nNext: switch mode with /mode observe|active|full-access and retry.`
        );
        await this.deps.audit.log({
          type: "policy_block",
          chatId,
          userId,
          repo: repoName,
          mode,
          runKind,
          requestId,
          reason: decision.reason
        });
        return;
      }

      if ((decision.requiresApproval || capabilityDecision.requiresApproval) && !params.bypassApproval) {
        const existingPending = this.deps.approvals.get(chatId);
        if (existingPending) {
          await this.deps.telegram.sendMessage(
            chatId,
            `Approval already pending for request ${existingPending.id}. Use /approve or /deny first.`
          );
          return;
        }

        this.deps.approvals.set({
          id: requestId,
          chatId,
          userId,
          repoName,
          mode,
          instruction,
          capabilityRef: params.capabilityAction ? toCapabilityRef(params.capabilityAction) : undefined,
          source: "codefox",
          createdAt: new Date().toISOString()
        });

        const pending = this.deps.approvals.get(chatId);
        if (!pending) {
          await this.deps.telegram.sendMessage(chatId, formatError("Failed to create approval record."));
          return;
        }

        await this.deps.audit.log({
          type: "approval_pending",
          chatId,
          userId,
          repo: repoName,
          mode,
          runKind,
          requestId,
          capabilityRef: pending.capabilityRef
        });
        await this.deps.telegram.sendMessage(
          chatId,
          formatApprovalPending(requestId, repoName, mode, toAuditPreview(instruction, 180), {
            requesterUserId: pending.userId,
            createdAt: pending.createdAt,
            capabilityRef: pending.capabilityRef
          })
        );
        return;
      }

      await this.executeTask({
        runKind,
        instruction,
        repoName,
        mode,
        requestId,
        userId,
        chatId,
        bypassApproval: Boolean(params.bypassApproval),
        attachments: params.attachments ?? [],
        capabilityAction: params.capabilityAction
      });
    } finally {
      this.executionAdmissionLock.delete(chatId);
      this.executionAdmissionSource.delete(chatId);
    }
  }

  private async executeTask(params: {
    runKind: RunKind;
    instruction: string;
    repoName: string;
    mode: PolicyMode;
    requestId: string;
    userId: number;
    chatId: number;
    bypassApproval: boolean;
    attachments: TaskAttachment[];
    capabilityAction?: CapabilityActionSpec;
  }): Promise<void> {
    const { runKind, instruction, repoName, mode, requestId, userId, chatId, attachments, capabilityAction } = params;

    let resultSent = false;
    let runResultResumeRejected = false;
    let runFinished = false;
    let startNoticeTimer: NodeJS.Timeout | undefined;

    try {
      const repo = this.deps.repos.get(repoName);
      const resumeThreadId = await this.resolveResumeThreadId(chatId, userId);

      const context: TaskContext = {
        chatId,
        userId,
        repoName,
        mode,
        instruction,
        requestId,
        runKind,
        systemGuidance: this.deps.instructionPolicy.buildExecutionGuidance(),
        resumeThreadId,
        reasoningEffortOverride: this.deps.sessions.getOrCreate(chatId).reasoningEffortOverride,
        attachments,
        capability: capabilityAction
          ? {
              ref: toCapabilityRef(capabilityAction),
              pack: capabilityAction.pack,
              action: capabilityAction.action,
              riskLevel: capabilityAction.riskLevel,
              approvalLevel: capabilityAction.approvalLevel,
              executionContext: capabilityAction.executionContext
            }
          : undefined
      };

      this.deps.sessions.setActiveRequest(chatId, requestId);
      startNoticeTimer = setTimeout(() => {
        if (runFinished) {
          return;
        }
        void this.deps.telegram
          .sendMessage(
            chatId,
            formatTaskStart(repoName, mode, requestId, runKind, Boolean(resumeThreadId), resumeThreadId)
          )
          .catch((error) => {
            console.error(`Failed to send task start message: ${String(error)}`);
          });
      }, TASK_START_NOTICE_DELAY_MS);

      await this.deps.audit.log({
        type: "codex_start",
        requestId,
        chatId,
        userId,
        repo: repoName,
        mode,
        runKind,
        resumeThreadId,
        capabilityRef: capabilityAction ? toCapabilityRef(capabilityAction) : undefined,
        capabilityPack: capabilityAction?.pack,
        capabilityAction: capabilityAction?.action,
        capabilityRiskLevel: capabilityAction?.riskLevel,
        capabilityApprovalLevel: capabilityAction?.approvalLevel
      });

      const running = this.deps.codex.startTask(repo.rootPath, context, async (line) => {
        await this.deps.audit.log({
          type: "codex_progress",
          requestId,
          chatId,
          linePreview: toAuditPreview(line),
          lineLength: line.length
        });
      });

      this.activeAborts.set(requestId, running.abort);
      await this.dispatchQueuedSteersOnRunStart(chatId, requestId);

      const result = await running.result;
      runResultResumeRejected = Boolean(result.resumeRejected);
      const suppressResultFromSteerAbort = result.aborted && this.steerTriggeredAborts.has(requestId);

      if (result.threadId) {
        this.deps.sessions.setCodexThread(chatId, result.threadId);
      } else if (resumeThreadId) {
        this.deps.sessions.touchCodexSession(chatId);
      }

      if (result.resumeRejected) {
        this.deps.sessions.clearCodexSession(chatId);
      }

      this.deps.sessions.setLastRunMetadata(chatId, {
        reasoningEffort: result.reasoningEffort,
        tokenUsage: result.tokenUsage
      });

      await this.deps.audit.log({
        type: "codex_finish",
        requestId,
        chatId,
        userId,
        ok: result.ok,
        exitCode: result.exitCode,
        aborted: result.aborted,
        timedOut: result.timedOut,
        resumeRejected: result.resumeRejected,
        threadId: result.threadId,
        reasoningEffort: result.reasoningEffort,
        tokenUsage: result.tokenUsage,
        summaryPreview: toAuditPreview(result.summary, 400),
        summaryLength: result.summary.length,
        capabilityRef: capabilityAction ? toCapabilityRef(capabilityAction) : undefined,
        capabilityPack: capabilityAction?.pack,
        capabilityAction: capabilityAction?.action
      });

      const completionButtons = ["/details", "/status"];
      const handoffState = this.externalHandoffs.get(chatId);
      if (handoffState) {
        if (countOutstandingHandoffWork(handoffState) > 0) {
          completionButtons.push(continueHandoffButton());
        } else {
          completionButtons.push(handoffDetailsButton());
        }
      }
      if (!suppressResultFromSteerAbort) {
        await this.deps.telegram.sendMessage(
          chatId,
          formatTaskResult(result, repoName, mode, {
            instructionPreview: toAuditPreview(instruction, 240)
          }),
          { commandButtons: completionButtons }
        );
        resultSent = true;
      }

      if (result.resumeRejected) {
        await this.deps.telegram.sendMessage(
          chatId,
          "Stored Codex session could not be resumed and was closed. Next /run will start a new session."
        );
      }
    } catch (error) {
      await this.deps.audit.log({
        type: "codex_orchestration_error",
        requestId,
        chatId,
        userId,
        error: String(error)
      });
      if (!resultSent) {
        await this.deps.telegram.sendMessage(chatId, formatError("Internal execution error. Check audit logs for details."));
      }
    } finally {
      runFinished = true;
      if (startNoticeTimer) {
        clearTimeout(startNoticeTimer);
      }
      this.activeAborts.delete(requestId);
      this.steerTriggeredAborts.delete(requestId);
      const session = this.deps.sessions.getOrCreate(chatId);
      if (session.activeRequestId === requestId) {
        this.deps.sessions.setActiveRequest(chatId, undefined);
      }

      if (!runResultResumeRejected) {
        queueMicrotask(() => {
          this.runDetached(chatId, this.consumePendingSteers(chatId), "consume_pending_steers");
        });
      } else {
        this.pendingSteers.delete(chatId);
      }
    }
  }

  private async dispatchQueuedSteersOnRunStart(chatId: number, requestId: string): Promise<void> {
    const queued = this.pendingSteers.get(chatId);
    if (!queued || queued.length === 0) {
      return;
    }

    await this.deps.audit.log({
      type: "steer_dispatch_requested_on_start",
      chatId,
      requestId,
      steerCount: queued.length
    });

    const abort = this.activeAborts.get(requestId);
    if (!abort) {
      return;
    }
    this.steerTriggeredAborts.add(requestId);
    abort();
  }

  private async resolveResumeThreadId(chatId: number, userId: number): Promise<string | undefined> {
    const session = this.deps.sessions.getOrCreate(chatId);
    if (!session.codexThreadId) {
      return undefined;
    }

    const lastActiveMs = session.codexLastActiveAt ? Date.parse(session.codexLastActiveAt) : Number.NaN;
    if (!Number.isFinite(lastActiveMs)) {
      this.deps.sessions.clearCodexSession(chatId);
      await this.deps.audit.log({
        type: "codex_session_closed",
        reason: "invalid_last_active",
        chatId,
        userId
      });
      return undefined;
    }

    const idleMs = Date.now() - lastActiveMs;
    const maxIdleMs = this.deps.codexSessionIdleMinutes * 60 * 1000;
    if (idleMs <= maxIdleMs) {
      return session.codexThreadId;
    }

    const expiredThreadId = session.codexThreadId;
    this.deps.sessions.clearCodexSession(chatId);
    await this.deps.audit.log({
      type: "codex_session_closed",
      reason: "idle_timeout",
      chatId,
      userId,
      threadId: expiredThreadId,
      idleMinutes: Math.floor(idleMs / 60000),
      maxIdleMinutes: this.deps.codexSessionIdleMinutes
    });
    const idleMinutes = Math.floor(idleMs / 60000);
    await this.deps.telegram.sendMessage(
      chatId,
      `Previous Codex session was idle for ${idleMinutes}m (limit ${this.deps.codexSessionIdleMinutes}m). Starting a new session.`
    );
    return undefined;
  }

  private async consumePendingSteers(chatId: number): Promise<void> {
    const steers = this.pendingSteers.get(chatId);
    if (!steers || steers.length === 0) {
      return;
    }

    const session = this.deps.sessions.getOrCreate(chatId);
    if (session.activeRequestId) {
      return;
    }

    this.pendingSteers.delete(chatId);

    if (!session.selectedRepo) {
      await this.deps.telegram.sendMessage(chatId, "Dropped pending steer because no repo is selected.");
      return;
    }

    const mergedInstruction = buildSteerInstruction(steers.map((item) => item.instruction));
    const steerUserId = steers[steers.length - 1].userId;
    const mergedAttachments = dedupeAttachments(steers.flatMap((item) => item.attachments));

    await this.deps.audit.log({
      type: "steer_dispatch",
      chatId,
      userId: steerUserId,
      steerCount: steers.length,
      instructionPreview: toAuditPreview(mergedInstruction)
    });

    await this.executeOrEnqueue({
      runKind: "steer",
      admissionSource: "steer",
      instruction: mergedInstruction,
      repoName: session.selectedRepo,
      mode: session.mode,
      chatId,
      userId: steerUserId,
      bypassApproval: true,
      attachments: mergedAttachments
    });
  }

  private runDetached(chatId: number, operation: Promise<void>, label: string): void {
    void operation.catch(async (error) => {
      try {
        await this.deps.audit.log({
          type: "detached_operation_error",
          chatId,
          label,
          error: String(error)
        });
      } catch (logError) {
        console.error(`Failed to write audit for detached error: ${String(logError)}`);
      }

      try {
        await this.deps.telegram.sendMessage(chatId, formatError("Internal scheduling error. Check audit logs for details."));
      } catch (sendError) {
        console.error(`Failed to send detached error message: ${String(sendError)}`);
      }
    });
  }

  private async sendAdmissionBusyMessage(chatId: number): Promise<void> {
    const session = this.deps.sessions.getOrCreate(chatId);
    const source = this.executionAdmissionSource.get(chatId);

    if (session.activeRequestId) {
      const canSteer = Boolean(this.activeAborts.get(session.activeRequestId));
      const steerHint = canSteer ? "send plain text to steer, " : "";
      if (source === "handoff_continue") {
        await this.deps.telegram.sendMessage(
          chatId,
          `Handoff continuation run ${session.activeRequestId} is active.\nNext: ${steerHint}use /status for context, or /abort to stop.`,
          { commandButtons: [showStatusButton(), abortRunButton()] }
        );
        return;
      }
      await this.deps.telegram.sendMessage(
        chatId,
        `Run ${session.activeRequestId} is active.\nNext: ${steerHint}use /status for context, or /abort to stop.`,
        { commandButtons: [showStatusButton(), abortRunButton()] }
      );
      return;
    }

    if (source === "handoff_continue") {
      await this.deps.telegram.sendMessage(
        chatId,
        "Handoff continuation is being prepared.\nNext: wait for the continuation update, or use /handoff show.",
        { commandButtons: [showStatusButton(), handoffDetailsButton()] }
      );
      return;
    }

    if (source) {
      await this.deps.telegram.sendMessage(
        chatId,
        `${formatAdmissionSource(source)} is being prepared for this chat.\nNext: wait for the update, or use /status.`,
        { commandButtons: [showStatusButton()] }
      );
      return;
    }

    await this.deps.telegram.sendMessage(
      chatId,
      "A request is currently being scheduled for this chat.\nNext: wait a moment, then retry or use /status.",
      { commandButtons: [showStatusButton()] }
    );
  }

  private validateHandoffSpecRef(chatId: number, specRevisionRef: string): { accepted: boolean; reason?: string } {
    const match = /^v(\d+)$/i.exec(specRevisionRef.trim());
    if (!match) {
      return {
        accepted: false,
        reason: `Invalid specRevisionRef '${specRevisionRef}'.`
      };
    }

    const workflow = this.specDrafts.get(chatId);
    if (!workflow) {
      return {
        accepted: false,
        reason: "No local spec workflow exists for this chat."
      };
    }
    const currentRevision = getCurrentRevision(workflow);
    if (currentRevision.status !== "approved") {
      return {
        accepted: false,
        reason: `Current spec v${currentRevision.version} is not approved.`
      };
    }

    const expectedVersion = Number(match[1]);
    if (currentRevision.version !== expectedVersion) {
      return {
        accepted: false,
        reason: `Spec version mismatch (handoff=${specRevisionRef}, current=v${currentRevision.version}).`
      };
    }

    return {
      accepted: true
    };
  }

  private decideCapabilityAdmission(mode: PolicyMode, capabilityAction?: CapabilityActionSpec): CapabilityAdmissionDecision {
    if (!capabilityAction) {
      return {
        allowed: true,
        requiresApproval: false,
        reasonCode: `legacy_untyped_${mode}`,
        reason: `Untyped ${mode}-mode run allowed.`
      };
    }

    if (!this.capabilityRegistry.isActionRunnableInMode(capabilityAction, mode)) {
      return {
        allowed: false,
        requiresApproval: false,
        reasonCode: "mode_disallows_action",
        reason: `Action ${capabilityAction.pack}.${capabilityAction.action} is not runnable in mode ${mode}.`
      };
    }

    switch (capabilityAction.approvalLevel) {
      case "auto-allowed":
        return {
          allowed: true,
          requiresApproval: false,
          reasonCode: "auto_allowed",
          reason: "Action is auto-allowed by capability policy."
        };
      case "approve-once":
      case "approve-each-write":
        return {
          allowed: true,
          requiresApproval: true,
          reasonCode: capabilityAction.approvalLevel,
          reason: "Action requires approval by capability policy."
        };
      case "local-presence-required":
        return {
          allowed: false,
          requiresApproval: false,
          reasonCode: "local_presence_required",
          reason: `Action ${capabilityAction.pack}.${capabilityAction.action} requires local presence.`
        };
      case "prohibited-remotely":
        return {
          allowed: false,
          requiresApproval: false,
          reasonCode: "prohibited_remotely",
          reason: `Action ${capabilityAction.pack}.${capabilityAction.action} is prohibited remotely.`
        };
    }
  }

  private persistState(): void {
    if (!this.deps.persistState) {
      return;
    }
    void this.deps.persistState().catch((error) => {
      console.error(`Failed to persist state: ${String(error)}`);
    });
  }

  private async handleCodexChangelogCheck(chatId: number, userId: number): Promise<void> {
    if (!this.deps.codexChangelogTracker) {
      await this.deps.telegram.sendMessage(
        chatId,
        formatError("Codex changelog checking is not configured in this runtime.")
      );
      return;
    }

    const viewId = makeViewId();
    try {
      const result = await this.deps.codexChangelogTracker.check(this.codexChangelogState);
      this.codexChangelogState = result.state;
      this.persistState();
      await this.deps.audit.log({
        type: "codex_changelog_checked",
        chatId,
        userId,
        viewId,
        sourceUrl: result.sourceUrl,
        checkedAt: result.checkedAt,
        newEntryCount: result.newEntries.length,
        latestEntryId: result.latestEntry?.id,
        latestEntryTitle: result.latestEntry?.title,
        decisions: result.newEntries.map((entry) => ({
          id: entry.id,
          decision: entry.decision,
          categories: entry.impactHints.map((hint) => hint.category)
        }))
      });
      await this.deps.telegram.sendMessage(chatId, addAuditRef(formatCodexChangelogCheck(result), viewId));
    } catch (error) {
      await this.deps.audit.log({
        type: "codex_changelog_check_failed",
        chatId,
        userId,
        viewId,
        error: String(error)
      });
      await this.deps.telegram.sendMessage(
        chatId,
        addAuditRef(
          formatError(
            "Codex changelog check failed.\nNext: verify outbound access to developers.openai.com or try again later."
          ),
          viewId
        )
      );
    }
  }
}

function buildSteerInstruction(instructions: string[]): string {
  const cleaned = instructions.map((entry) => entry.trim()).filter(Boolean);
  if (cleaned.length === 1) {
    return [
      "Steer update from the user:",
      cleaned[0],
      "Continue from the current session state and incorporate this direction."
    ].join("\n");
  }

  return [
    "Steer update from the user:",
    "Merge all guidance items below and continue from the current session state.",
    ...cleaned.map((entry, index) => `${index + 1}. ${entry}`)
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
}

function dedupeAttachments(attachments: TaskAttachment[]): TaskAttachment[] {
  const seen = new Set<string>();
  const unique: TaskAttachment[] = [];
  for (const attachment of attachments) {
    const key = `${attachment.kind}:${attachment.localPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(attachment);
  }
  return unique;
}

function addAuditRef(message: string, viewId: string): string {
  return `${message}\naudit ref: ${viewId}`;
}

function trimTerminalPunctuation(input: string): string {
  return input.trim().replace(/[.!\s]+$/g, "");
}

function formatAdmissionSource(source: AdmissionSource): string {
  switch (source) {
    case "run":
      return "Run request";
    case "act":
      return "Typed action request";
    case "handoff_continue":
      return "Handoff continuation";
    case "steer":
      return "Steer update";
    default:
      return "Request";
  }
}

function selectPreferredRepoForChat(
  chatId: number,
  availableRepoNames: string[],
  sessions: Array<{ chatId: number; selectedRepo?: string; updatedAt: string }>
): string | undefined {
  if (availableRepoNames.length === 1) {
    return availableRepoNames[0];
  }

  const available = new Set(availableRepoNames);
  const currentChatRecent = [...sessions]
    .filter((session) => session.chatId === chatId && session.selectedRepo && available.has(session.selectedRepo))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (currentChatRecent?.selectedRepo) {
    return currentChatRecent.selectedRepo;
  }

  const globalRecent = [...sessions]
    .filter((session) => session.selectedRepo && available.has(session.selectedRepo))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (globalRecent?.selectedRepo) {
    return globalRecent.selectedRepo;
  }

  return availableRepoNames[0];
}

function formatExternalHandoffStatus(state: ExternalHandoffState): string {
  const outstanding = state.bundle.remainingWork.filter((work) => !state.continuedWorkIds.includes(work.id));
  const nextWork = outstanding[0];
  const handoffStateLabel = state.awaitingConfirmation
    ? "awaiting_acceptance"
    : state.awaitingExternalCompletion
      ? "waiting_for_external_completion"
      : outstanding.length > 0
        ? "ready_to_continue"
        : "continued";
  return [
    `Handoff ${state.bundle.handoffId}`,
    `state: ${handoffStateLabel}`,
    `source repo: ${state.sourceRepoName ?? "(not provided)"}`,
    `source path: ${state.sourceRepoPath ?? "(not provided)"}`,
    `task id: ${state.bundle.taskId}`,
    `external completion: ${state.externalCompletionStatus}${
      state.externalCompletionSummary ? ` - ${state.externalCompletionSummary}` : ""
    }`,
    `remaining: ${outstanding.length}/${state.bundle.remainingWork.length}`,
    `next: ${nextWork ? `${nextWork.id} - ${nextWork.summary}` : "none"}`
  ].join("\n");
}

function formatExternalHandoffDetail(state: ExternalHandoffState): string {
  const lines = [
    `Handoff detail: ${state.bundle.handoffId}`,
    `source session: ${state.sourceSessionId ?? "(not provided)"}`,
    `source repo: ${state.sourceRepoName ?? "(not provided)"}`,
    `source path: ${state.sourceRepoPath ?? "(not provided)"}`,
    `source mode: ${state.sourceMode ?? "(not provided)"}`,
    `task id: ${state.bundle.taskId}`,
    `spec ref: ${state.bundle.specRevisionRef}`,
    `accepted: ${state.awaitingConfirmation ? "no" : `yes${state.acceptedAt ? ` (${state.acceptedAt})` : ""}`}`,
    `waiting for external completion: ${state.awaitingExternalCompletion ? "yes" : "no"}`,
    `external completion: ${state.externalCompletionStatus}${
      state.externalCompletionSummary ? ` - ${state.externalCompletionSummary}` : ""
    }`,
    `completed work count: ${state.bundle.completedWork.length}`,
    `outstanding work: ${countOutstandingHandoffWork(state)}/${state.bundle.remainingWork.length}`,
    "handoff work:"
  ];

  for (const [index, work] of state.bundle.remainingWork.entries()) {
    const status = state.continuedWorkIds.includes(work.id) ? "continued" : "pending";
    lines.push(
      `${index + 1}. ${work.id} [${status}] ${work.summary}${
        work.requestedCapabilityRef ? ` (capability=${work.requestedCapabilityRef})` : ""
      }`
    );
  }

  if (state.bundle.unresolvedRisks && state.bundle.unresolvedRisks.length > 0) {
    lines.push(`unresolved risks: ${state.bundle.unresolvedRisks.join(" | ")}`);
  }
  if (state.bundle.unresolvedQuestions && state.bundle.unresolvedQuestions.length > 0) {
    lines.push(`unresolved questions: ${state.bundle.unresolvedQuestions.join(" | ")}`);
  }
  return lines.join("\n");
}

function countOutstandingHandoffWork(state: ExternalHandoffState): number {
  return state.bundle.remainingWork.filter((work) => !state.continuedWorkIds.includes(work.id)).length;
}

function isActionableHandoffState(state: ExternalHandoffState): boolean {
  return state.awaitingConfirmation || state.awaitingExternalCompletion || countOutstandingHandoffWork(state) > 0;
}

function buildPrimaryCommandButtons(
  activeRequestId: string | undefined,
  hasPendingApproval: boolean,
  handoffState: ExternalHandoffState | undefined
): string[] {
  if (hasPendingApproval) {
    return [approveRequestButton(), denyRequestButton(), showStatusButton(), stopServiceButton()];
  }
  if (activeRequestId) {
    return [abortRunButton(), showStatusButton(), showDetailsButton(), stopServiceButton()];
  }
  if (handoffState) {
    if (!isActionableHandoffState(handoffState)) {
      return [showStatusButton(), showDetailsButton(), showPendingButton(), stopServiceButton()];
    }
    if (handoffState.awaitingConfirmation) {
      return [acceptHandoffButton(), rejectHandoffButton(), handoffDetailsButton(), showStatusButton()];
    }
    if (handoffState.awaitingExternalCompletion) {
      return [showStatusButton(), handoffDetailsButton(), stopServiceButton()];
    }
    return [continueHandoffButton(), handoffDetailsButton(), showStatusButton(), stopServiceButton()];
  }
  return [showStatusButton(), showDetailsButton(), showPendingButton(), stopServiceButton()];
}

function buildHandoffCommandButtons(state: ExternalHandoffState): string[] {
  if (state.awaitingConfirmation) {
    return buildHandoffConfirmationButtons();
  }
  if (state.awaitingExternalCompletion) {
    return [showStatusButton(), handoffDetailsButton(), stopServiceButton()];
  }
  if (countOutstandingHandoffWork(state) > 0) {
    return [continueHandoffButton(), handoffDetailsButton(), showStatusButton()];
  }
  return [showStatusButton()];
}

function buildHandoffSelectionCommandButtons(state: ExternalHandoffState): string[] {
  const outstanding = state.bundle.remainingWork.filter((work) => !state.continuedWorkIds.includes(work.id));
  const commands = [handoffDetailsButton(), continueHandoffButton()];
  if (outstanding[1]) {
    commands.push("/continue 2");
  } else if (outstanding[0]) {
    commands.push("/continue 1");
  }
  return commands;
}

function buildHandoffConfirmationButtons(): string[] {
  return [acceptHandoffButton(), rejectHandoffButton(), handoffDetailsButton(), showStatusButton()];
}

function parseHandoffConfirmationDecision(input: string): "accept" | "reject" | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (new Set(["yes", "y", "accept", "accept handoff", "accepted", "ok", "/yes", "/accept"]).has(normalized)) {
    return "accept";
  }

  if (new Set(["no", "n", "reject", "reject handoff", "rejected", "deny", "decline", "/no", "/reject"]).has(normalized)) {
    return "reject";
  }

  return undefined;
}

function resolveOutstandingHandoffWork(
  outstanding: Array<{ id: string; summary: string; requestedCapabilityRef?: string }>,
  selector: string
): { id: string; summary: string; requestedCapabilityRef?: string } | undefined {
  const trimmed = selector.trim();
  if (!trimmed) {
    return undefined;
  }

  const byId = outstanding.find((work) => work.id === trimmed);
  if (byId) {
    return byId;
  }

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed);
    if (Number.isSafeInteger(index) && index > 0 && index <= outstanding.length) {
      return outstanding[index - 1];
    }
  }

  return undefined;
}

function showStatusButton(): string {
  return "/status";
}

function showDetailsButton(): string {
  return "/details";
}

function showPendingButton(): string {
  return "/pending";
}

function approveRequestButton(): string {
  return "/approve";
}

function denyRequestButton(): string {
  return "/deny";
}

function abortRunButton(): string {
  return "/abort";
}

function stopServiceButton(): string {
  return "/service stop";
}

function confirmStopButton(): string {
  return "/service stop confirm";
}

function acceptHandoffButton(): string {
  return "/accept";
}

function rejectHandoffButton(): string {
  return "/reject";
}

function continueHandoffButton(): string {
  return "/continue";
}

function handoffDetailsButton(): string {
  return "/handoff show";
}

function helpButton(): string {
  return "/help";
}

function ensureHelpButton(buttons?: string[]): string[] {
  const normalized = Array.isArray(buttons) ? buttons.map((entry) => entry.trim()).filter(Boolean) : [];
  const deduped = [...new Set(normalized)];
  if (!deduped.includes(helpButton())) {
    deduped.push(helpButton());
  }
  return deduped;
}

function renderOutstandingHandoffChoices(
  outstanding: Array<{ id: string; summary: string; requestedCapabilityRef?: string }>
): string {
  return outstanding
    .slice(0, 8)
    .map((work, index) => `${index + 1}. /continue ${index + 1} -> ${work.id} - ${work.summary}`)
    .join("\n");
}

function parseRepoFromExternalSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) {
    return undefined;
  }
  const match = /^chat:\d+\/repo:([^/]+)\/mode:(observe|active|full-access)$/.exec(sessionId.trim());
  return match?.[1];
}

function parseModeFromExternalSessionId(sessionId: string | undefined): PolicyMode | undefined {
  if (!sessionId) {
    return undefined;
  }
  const match = /^chat:\d+\/repo:[^/]+\/mode:(observe|active|full-access)$/.exec(sessionId.trim());
  const mode = match?.[1];
  if (mode === "observe" || mode === "active" || mode === "full-access") {
    return mode;
  }
  return undefined;
}

export function createControllerFromAdapters(params: {
  telegram: TelegramAdapter;
  access: AccessControl;
  repos: RepoRegistry;
  sessions: SessionManager;
  policy: PolicyEngine;
  approvals: ApprovalStore;
  audit: AuditLogger;
  codex: CodexCliAdapter;
  persistRepos?: (repos: RepoConfig[]) => Promise<void>;
  repoInitDefaultParentPath: string;
  initializeRepo?: (repoPath: string) => Promise<void>;
  requireAgentsForRuns: boolean;
  instructionPolicy: InstructionPolicy;
  codexSessionIdleMinutes: number;
  codexDefaultReasoningEffort?: CodexReasoningEffort;
  initialSpecWorkflows?: Array<{ chatId: number; workflow: SpecWorkflowState }>;
  initialExternalHandoffs?: ExternalHandoffStateSnapshot[];
  persistState?: () => Promise<void>;
  specPolicy?: SpecPolicyEngine;
  capabilityRegistry?: CapabilityRegistry;
  codexChangelogTracker?: CodexChangelogTracker;
  initialCodexChangelogState?: CodexChangelogStateSnapshot;
  externalApprovalDecision?: (input: {
    leaseId: string;
    approvalKey: string;
    approved: boolean;
    chatId: number;
    userId: number;
  }) => Promise<boolean>;
  requestServiceStop?: (input: { chatId: number; userId: number }) => Promise<boolean>;
}): CodeFoxController {
  return new CodeFoxController({
    telegram: params.telegram,
    access: params.access,
    repos: params.repos,
    sessions: params.sessions,
    policy: params.policy,
    approvals: params.approvals,
    audit: params.audit,
    codex: params.codex,
    persistRepos: params.persistRepos,
    repoInitDefaultParentPath: params.repoInitDefaultParentPath,
    initializeRepo: params.initializeRepo,
    requireAgentsForRuns: params.requireAgentsForRuns,
    instructionPolicy: params.instructionPolicy,
    codexSessionIdleMinutes: params.codexSessionIdleMinutes,
    codexDefaultReasoningEffort: params.codexDefaultReasoningEffort,
    initialSpecWorkflows: params.initialSpecWorkflows,
    initialExternalHandoffs: params.initialExternalHandoffs,
    persistState: params.persistState,
    specPolicy: params.specPolicy,
    capabilityRegistry: params.capabilityRegistry,
    codexChangelogTracker: params.codexChangelogTracker,
    initialCodexChangelogState: params.initialCodexChangelogState,
    externalApprovalDecision: params.externalApprovalDecision,
    requestServiceStop: params.requestServiceStop
  });
}

function cloneSpecWorkflow(workflow: SpecWorkflowState): SpecWorkflowState {
  return {
    revisions: workflow.revisions.map((revision) => ({
      ...revision,
      sections: {
        ...revision.sections,
        CONSTRAINTS: [...revision.sections.CONSTRAINTS],
        NON_GOALS: [...revision.sections.NON_GOALS],
        CONTEXT: [...revision.sections.CONTEXT],
        ASSUMPTIONS: [...revision.sections.ASSUMPTIONS],
        QUESTIONS: [...revision.sections.QUESTIONS],
        PLAN: [...revision.sections.PLAN],
        APPROVALS_REQUIRED: [...revision.sections.APPROVALS_REQUIRED],
        DONE_WHEN: [...revision.sections.DONE_WHEN]
      }
    }))
  };
}

function cloneExternalHandoffBundle(handoff: ExternalCodexHandoffBundle): ExternalCodexHandoffBundle {
  return {
    ...handoff,
    completedWork: [...handoff.completedWork],
    remainingWork: handoff.remainingWork.map((work) => ({ ...work })),
    sourceRepo: handoff.sourceRepo
      ? {
          name: handoff.sourceRepo.name,
          rootPath: handoff.sourceRepo.rootPath
        }
      : undefined,
    evidenceRefs: handoff.evidenceRefs ? [...handoff.evidenceRefs] : undefined,
    unresolvedQuestions: handoff.unresolvedQuestions ? [...handoff.unresolvedQuestions] : undefined,
    unresolvedRisks: handoff.unresolvedRisks ? [...handoff.unresolvedRisks] : undefined
  };
}

function mapExternalBundleToStateBundle(bundle: ExternalCodexHandoffBundle): ExternalHandoffBundleState {
  return {
    schemaVersion: bundle.schemaVersion,
    leaseId: bundle.leaseId,
    handoffId: bundle.handoffId,
    clientId: bundle.clientId,
    createdAt: bundle.createdAt,
    taskId: bundle.taskId,
    specRevisionRef: bundle.specRevisionRef,
    completedWork: [...bundle.completedWork],
    remainingWork: bundle.remainingWork.map((work) => ({ ...work })),
    sourceRepo: bundle.sourceRepo
      ? {
          name: bundle.sourceRepo.name,
          rootPath: bundle.sourceRepo.rootPath
        }
      : undefined,
    evidenceRefs: bundle.evidenceRefs ? [...bundle.evidenceRefs] : undefined,
    unresolvedQuestions: bundle.unresolvedQuestions ? [...bundle.unresolvedQuestions] : undefined,
    unresolvedRisks: bundle.unresolvedRisks ? [...bundle.unresolvedRisks] : undefined
  };
}

function mapStateBundleToExternalBundle(bundle: ExternalHandoffBundleState): ExternalCodexHandoffBundle {
  return {
    schemaVersion: bundle.schemaVersion as ExternalCodexHandoffBundle["schemaVersion"],
    leaseId: bundle.leaseId,
    handoffId: bundle.handoffId,
    clientId: bundle.clientId,
    createdAt: bundle.createdAt,
    taskId: bundle.taskId,
    specRevisionRef: bundle.specRevisionRef,
    completedWork: [...bundle.completedWork],
    remainingWork: bundle.remainingWork.map((work) => ({ ...work })),
    sourceRepo: bundle.sourceRepo
      ? {
          name: bundle.sourceRepo.name,
          rootPath: bundle.sourceRepo.rootPath
        }
      : undefined,
    evidenceRefs: bundle.evidenceRefs ? [...bundle.evidenceRefs] : undefined,
    unresolvedQuestions: bundle.unresolvedQuestions ? [...bundle.unresolvedQuestions] : undefined,
    unresolvedRisks: bundle.unresolvedRisks ? [...bundle.unresolvedRisks] : undefined
  };
}
