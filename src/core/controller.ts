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
import { parseCommand, type ParsedCommand } from "./command-parser.js";
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
import type { ExternalCodexHandoffBundle } from "./external-codex-integration.js";
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
}

const SHUTDOWN_ABORT_TIMEOUT_MS = 5000;
const SHUTDOWN_ABORT_POLL_INTERVAL_MS = 50;
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
  externalApprovalDecision?: (input: {
    leaseId: string;
    approvalKey: string;
    approved: boolean;
    chatId: number;
    userId: number;
  }) => Promise<boolean>;
}

export class CodeFoxController {
  private readonly activeAborts = new Map<string, () => void>();
  private readonly executionAdmissionLock = new Set<number>();
  private readonly executionAdmissionSource = new Map<number, AdmissionSource>();
  private readonly pendingSteers = new Map<number, PendingSteer[]>();
  private readonly attachmentContext = new Map<number, TaskAttachment[]>();
  private readonly specDrafts = new Map<number, SpecWorkflowState>();
  private readonly externalHandoffs = new Map<number, ExternalHandoffState>();
  private readonly specPolicy: SpecPolicyEngine;
  private readonly capabilityRegistry: CapabilityRegistry;

  constructor(private readonly deps: ControllerDeps) {
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
        continuedWorkIds: [...entry.continuedWorkIds]
      });
    }
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
        continuedWorkIds: [...handoff.continuedWorkIds]
      }));
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
    sourceSessionId?: string
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

    this.externalHandoffs.set(chatId, {
      leaseId,
      sourceSessionId: sourceSessionId?.trim(),
      sourceRepoName: handoff.sourceRepo?.name?.trim() || parseRepoFromExternalSessionId(sourceSessionId),
      sourceRepoPath: handoff.sourceRepo?.rootPath?.trim() || undefined,
      sourceMode: parseModeFromExternalSessionId(sourceSessionId),
      bundle: cloneExternalHandoffBundle(handoff),
      receivedAt: new Date().toISOString(),
      continuedWorkIds: []
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
    const handoffState = this.externalHandoffs.get(chatId);
    const commandButtons = handoffState ? buildHandoffCommandButtons(handoffState) : [];
    const nextWork = handoff.remainingWork[0];
    await this.deps.telegram.sendMessage(
      chatId,
      [
        `Handoff ${handoff.handoffId} is ready.`,
        `task: ${handoff.taskId}`,
        `remaining: ${handoff.remainingWork.length}`,
        `next: ${nextWork ? `${nextWork.id} - ${nextWork.summary}` : "none"}`
      ].join("\n"),
      commandButtons.length > 0 ? { commandButtons } : undefined
    );
    return {
      accepted: true
    };
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

    switch (command.type) {
      case "help": {
        await this.deps.telegram.sendMessage(chatId, formatHelp());
        return;
      }
      case "repos": {
        await this.deps.telegram.sendMessage(chatId, formatRepos(this.deps.repos.list().map((repo) => repo.name)));
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
          )
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
          commandButtons: ["/status", "/handoff show", "/pending"]
        });
        return;
      }
      case "pending": {
        const pending = this.deps.approvals.get(chatId);
        if (!pending) {
          await this.deps.telegram.sendMessage(chatId, "No pending approval.");
          return;
        }
        await this.deps.telegram.sendMessage(chatId, formatPendingApproval(pending));
        return;
      }
      case "handoff": {
        await this.handleHandoffCommand(chatId, userId, command);
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
        if (!session.selectedRepo) {
          await this.deps.telegram.sendMessage(chatId, "Select a repo first with /repo <name>.");
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
            repoName: session.selectedRepo,
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
        if (!session.selectedRepo) {
          await this.deps.telegram.sendMessage(chatId, "Select a repo first with /repo <name>.");
          return;
        }
        const attachments = this.resolveAttachmentsForRun(chatId, downloadedAttachments);
        this.runDetached(
          chatId,
          this.executeOrEnqueue({
            runKind: "run",
            admissionSource: "run",
            instruction: command.instruction,
            repoName: session.selectedRepo,
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
        await this.deps.telegram.sendMessage(chatId, "Unknown command. Use /help.");
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
      await this.deps.telegram.sendMessage(chatId, "No active Codex session to close.");
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

  private async handleApprove(chatId: number, userId: number): Promise<void> {
    const pending = this.deps.approvals.get(chatId);
    if (!pending) {
      await this.deps.telegram.sendMessage(chatId, "No pending approval.");
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
        await this.deps.telegram.sendMessage(chatId, "External approval bridge is not configured.");
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
        await this.deps.telegram.sendMessage(chatId, "External approval request is stale or unknown.");
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
        `Capability policy blocked run: ${
          pending.capabilityRef
            ? `Unknown capability action '${pending.capabilityRef}'.`
            : "Select a typed action with /act <pack.action> <instruction>."
        }`
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
      await this.deps.telegram.sendMessage(chatId, "No pending approval.");
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
        await this.deps.telegram.sendMessage(chatId, "External approval bridge is not configured.");
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
        await this.deps.telegram.sendMessage(chatId, "External approval request is stale or unknown.");
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

  private async handleHandoffCommand(
    chatId: number,
    userId: number,
    command: Extract<ParsedCommand, { type: "handoff" }>
  ): Promise<void> {
    const state = this.externalHandoffs.get(chatId);
    if (command.action === "clear") {
      if (!state) {
        await this.deps.telegram.sendMessage(chatId, "No external handoff is currently stored.");
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
      await this.deps.telegram.sendMessage(chatId, "No external handoff available.");
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

    const session = this.deps.sessions.getOrCreate(chatId);
    if (state.sourceRepoName && session.selectedRepo !== state.sourceRepoName) {
      if (!this.deps.repos.has(state.sourceRepoName)) {
        if (state.sourceRepoPath) {
          const registeredPath = await this.tryRegisterSourceRepoFromHandoff(
            chatId,
            userId,
            state.sourceRepoName,
            state.sourceRepoPath
          );
          if (!registeredPath) {
            await this.deps.telegram.sendMessage(
              chatId,
              `Cannot continue handoff ${state.bundle.handoffId}: source repo '${state.sourceRepoName}' could not be auto-registered from '${state.sourceRepoPath}'. Use /repo add ${state.sourceRepoName} <absolute-path>.`
            );
            return;
          }
          this.externalHandoffs.set(chatId, {
            ...state,
            sourceRepoPath: registeredPath
          });
          this.persistState();
          await this.deps.telegram.sendMessage(
            chatId,
            `Handoff source repo auto-registered: ${state.sourceRepoName}\npath: ${registeredPath}`
          );
        } else {
          await this.deps.telegram.sendMessage(
            chatId,
            `Cannot continue handoff ${state.bundle.handoffId}: source repo '${state.sourceRepoName}' is not registered. Use /repo add ${state.sourceRepoName} <absolute-path>.`
          );
          return;
        }
      }
      this.deps.sessions.setRepo(chatId, state.sourceRepoName);
      this.deps.sessions.clearCodexSession(chatId);
      await this.deps.audit.log({
        type: "external_handoff_repo_aligned",
        chatId,
        userId,
        handoffId: state.bundle.handoffId,
        sourceRepo: state.sourceRepoName
      });
      await this.deps.telegram.sendMessage(
        chatId,
        `Handoff source repo detected: switched to ${state.sourceRepoName} for continuation.`
      );
    }
    if (!session.selectedRepo) {
      await this.deps.telegram.sendMessage(chatId, "Select a repo first with /repo <name>.");
      return;
    }
    const specValidation = this.validateHandoffSpecRef(chatId, state.bundle.specRevisionRef);
    if (!specValidation.accepted) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Cannot continue handoff ${state.bundle.handoffId}: ${specValidation.reason}`
      );
      return;
    }
    if (session.activeRequestId) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Request ${session.activeRequestId} is already running. Use /status or /abort first.`
      );
      return;
    }

    const outstanding = state.bundle.remainingWork.filter((work) => !state.continuedWorkIds.includes(work.id));
    if (outstanding.length === 0) {
      await this.deps.telegram.sendMessage(chatId, "All handoff work items are already continued.");
      return;
    }

    const nextWork = command.workId
      ? outstanding.find((work) => work.id === command.workId)
      : outstanding[0];
    if (!nextWork) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Work item '${command.workId}' is not available. Use /handoff show for valid ids.`
      );
      return;
    }

    const capabilityAction = nextWork.requestedCapabilityRef
      ? this.capabilityRegistry.resolveAction(nextWork.requestedCapabilityRef)
      : undefined;
    if (nextWork.requestedCapabilityRef && !capabilityAction) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Unknown capability action '${nextWork.requestedCapabilityRef}' for handoff item '${nextWork.id}'.`
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

    this.externalHandoffs.set(chatId, {
      ...state,
      continuedWorkIds: [...state.continuedWorkIds, nextWork.id]
    });
    this.persistState();
    await this.deps.audit.log({
      type: "external_handoff_continue_requested",
      chatId,
      userId,
      handoffId: state.bundle.handoffId,
      workId: nextWork.id,
      capabilityRef: nextWork.requestedCapabilityRef
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
      await this.deps.telegram.sendMessage(chatId, "No active request.");
      return;
    }
    const abort = this.activeAborts.get(session.activeRequestId);
    if (!abort) {
      await this.deps.telegram.sendMessage(chatId, "Active request cannot be aborted right now.");
      return;
    }

    this.pendingSteers.delete(chatId);
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
      await this.deps.telegram.sendMessage(chatId, "Select a repo first with /repo <name>.");
      return;
    }

    if (!session.activeRequestId) {
      await this.deps.telegram.sendMessage(
        chatId,
        "No active run to steer.\nNext: start a run with plain text or /run <instruction>."
      );
      return;
    }

    const abort = this.activeAborts.get(session.activeRequestId);
    if (!abort) {
      await this.deps.telegram.sendMessage(chatId, "Active request cannot accept /steer right now.");
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
      await this.deps.telegram.sendMessage(
        chatId,
        `Steer received for ${session.activeRequestId}. Interrupting run and resuming the same Codex session.`
      );
      abort();
      return;
    }

    await this.deps.telegram.sendMessage(
      chatId,
      `Additional steer captured (${existing.length} pending). Instructions will be merged into the next resume.`
    );
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
      await this.deps.telegram.sendMessage(
        chatId,
        formatTaskStart(repoName, mode, requestId, runKind, Boolean(resumeThreadId), resumeThreadId)
      );

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

      const result = await running.result;
      runResultResumeRejected = Boolean(result.resumeRejected);

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

      await this.deps.telegram.sendMessage(chatId, formatTaskResult(result, repoName, mode));
      resultSent = true;

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
      this.activeAborts.delete(requestId);
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

    await this.deps.telegram.sendMessage(chatId, `Applying ${steers.length} steer update(s) on the current Codex session.`);

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
    if (source === "handoff_continue") {
      await this.deps.telegram.sendMessage(
        chatId,
        "Handoff continuation is being scheduled. Next: wait for the continuation update, or check /handoff status.",
        { commandButtons: ["/handoff status", "/status"] }
      );
      return;
    }

    if (session.activeRequestId) {
      await this.deps.telegram.sendMessage(
        chatId,
        `Run ${session.activeRequestId} is active.\nNext: send plain text to steer, use /status for context, or /abort to stop.`,
        { commandButtons: ["/status", "/abort"] }
      );
      return;
    }

    await this.deps.telegram.sendMessage(
      chatId,
      "A request is currently being scheduled for this chat.\nNext: wait a moment, then retry or use /status.",
      { commandButtons: ["/status"] }
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

function formatExternalHandoffStatus(state: ExternalHandoffState): string {
  const outstanding = state.bundle.remainingWork.filter((work) => !state.continuedWorkIds.includes(work.id));
  const nextWork = outstanding[0];
  return [
    `Handoff ${state.bundle.handoffId}`,
    `source repo: ${state.sourceRepoName ?? "(not provided)"}`,
    `source path: ${state.sourceRepoPath ?? "(not provided)"}`,
    `task id: ${state.bundle.taskId}`,
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
    `completed work count: ${state.bundle.completedWork.length}`,
    "remaining work:"
  ];

  for (const work of state.bundle.remainingWork) {
    const status = state.continuedWorkIds.includes(work.id) ? "continued" : "pending";
    lines.push(
      `- ${work.id} [${status}] ${work.summary}${
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

function buildHandoffCommandButtons(state: ExternalHandoffState): string[] {
  const outstanding = state.bundle.remainingWork.filter((work) => !state.continuedWorkIds.includes(work.id));
  const nextWork = outstanding[0];
  const commands = ["/handoff show"];
  if (nextWork) {
    commands.push(`/continue ${nextWork.id}`);
  } else {
    commands.push("/handoff status");
  }
  return commands;
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
  externalApprovalDecision?: (input: {
    leaseId: string;
    approvalKey: string;
    approved: boolean;
    chatId: number;
    userId: number;
  }) => Promise<boolean>;
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
    externalApprovalDecision: params.externalApprovalDecision
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
