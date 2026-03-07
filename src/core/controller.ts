import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CodexCliAdapter, RunningTask } from "../adapters/codex.js";
import type { TelegramAdapter, TelegramUpdate } from "../adapters/telegram.js";
import type { AccessControl } from "./auth.js";
import type { AuditEventInput, AuditLogger } from "./audit-logger.js";
import { parseCommand } from "./command-parser.js";
import type { ApprovalStore } from "./approval-store.js";
import type { PolicyEngine } from "./policy.js";
import type { RepoRegistry } from "./repo-registry.js";
import { toAuditPreview } from "./sanitize.js";
import type { InstructionPolicy } from "./instruction-policy.js";
import {
  formatApprovalPending,
  formatError,
  formatHelp,
  formatMode,
  formatPendingApproval,
  formatRepoInfo,
  formatRepos,
  formatSessionStatus,
  formatTaskResult,
  formatTaskStart
} from "./response-formatter.js";
import type { SessionManager } from "./session-manager.js";
import { makeRequestId } from "./ids.js";
import type { PlainTextMode, PolicyMode, RepoConfig, TaskContext, TaskType } from "../types/domain.js";

interface MessageSink {
  sendMessage(chatId: number, text: string): Promise<void>;
}

interface AuditSink {
  log(event: AuditEventInput): Promise<void>;
}

interface CodexRunner {
  startTask(
    repoPath: string,
    context: TaskContext,
    onProgress?: (line: string) => void | Promise<void>
  ): RunningTask;
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
  plainTextMode: PlainTextMode;
  persistRepos?: (repos: RepoConfig[]) => Promise<void>;
  repoInitDefaultParentPath: string;
  initializeRepo?: (repoPath: string) => Promise<void>;
  requireAgentsForMutatingTasks: boolean;
  instructionPolicy: InstructionPolicy;
}

export class CodeFoxController {
  private readonly activeAborts = new Map<string, () => void>();
  private readonly executionAdmissionLock = new Set<number>();

  constructor(private readonly deps: ControllerDeps) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || typeof message.text !== "string" || !message.from) {
      return;
    }

    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text;

    try {
      this.deps.access.assertAuthorized({ userId, chatId });
    } catch {
      await this.deps.telegram.sendMessage(chatId, "Unauthorized.");
      return;
    }

    const session = this.deps.sessions.getOrCreate(chatId);
    const command = parseCommand(text, this.deps.plainTextMode);

    await this.deps.audit.log({
      type: "request_received",
      chatId,
      userId,
      textPreview: toAuditPreview(text),
      textLength: text.length,
      parsedType: command.type,
      mode: session.mode,
      repo: session.selectedRepo
    });

    switch (command.type) {
      case "help": {
        await this.deps.telegram.sendMessage(chatId, formatHelp());
        return;
      }
      case "repos": {
        await this.deps.telegram.sendMessage(
          chatId,
          formatRepos(this.deps.repos.list().map((repo) => repo.name))
        );
        return;
      }
      case "repo": {
        try {
          this.deps.repos.get(command.repoName);
          this.deps.sessions.setRepo(chatId, command.repoName);
          await this.deps.telegram.sendMessage(chatId, `Repo set to ${command.repoName}.`);
          await this.deps.audit.log({ type: "repo_selected", chatId, userId, repo: command.repoName });
        } catch (error) {
          await this.deps.telegram.sendMessage(chatId, formatError(String(error)));
        }
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
      case "repo_remove": {
        await this.handleRepoRemove(chatId, userId, command.repoName);
        return;
      }
      case "repo_info": {
        const targetName = command.repoName ?? session.selectedRepo;
        if (!targetName) {
          await this.deps.telegram.sendMessage(
            chatId,
            "No repo selected. Use /repo <name> or /repo info <name>."
          );
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
        this.deps.sessions.setMode(chatId, command.mode);
        await this.deps.telegram.sendMessage(chatId, formatMode(command.mode));
        await this.deps.audit.log({ type: "mode_changed", chatId, userId, mode: command.mode });
        return;
      }
      case "status": {
        await this.deps.telegram.sendMessage(chatId, formatSessionStatus(this.deps.sessions.getOrCreate(chatId)));
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
      case "approve": {
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
        if (session.activeRequestId) {
          await this.deps.telegram.sendMessage(
            chatId,
            `Request ${session.activeRequestId} is already running. Use /status or /abort first.`
          );
          return;
        }
        this.deps.approvals.delete(chatId);
        await this.deps.audit.log({ type: "approval_granted", chatId, userId, requestId: pending.id });
        this.runDetached(
          chatId,
          this.executeTask(
            pending.taskType,
            pending.instruction,
            pending.repoName,
            pending.mode,
            pending.id,
            pending.userId,
            pending.chatId
          ),
          "approve_execute_task"
        );
        return;
      }
      case "deny": {
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
        this.deps.approvals.delete(chatId);
        await this.deps.audit.log({ type: "approval_denied", chatId, userId, requestId: pending.id });
        await this.deps.telegram.sendMessage(chatId, `Denied request ${pending.id}.`);
        return;
      }
      case "abort": {
        if (!session.activeRequestId) {
          await this.deps.telegram.sendMessage(chatId, "No active request.");
          return;
        }
        const abort = this.activeAborts.get(session.activeRequestId);
        if (!abort) {
          await this.deps.telegram.sendMessage(chatId, "Active request cannot be aborted right now.");
          return;
        }
        abort();
        await this.deps.audit.log({
          type: "request_abort",
          chatId,
          userId,
          requestId: session.activeRequestId
        });
        await this.deps.telegram.sendMessage(chatId, `Abort signal sent for ${session.activeRequestId}.`);
        return;
      }
      case "ask": {
        if (!session.selectedRepo) {
          await this.deps.telegram.sendMessage(chatId, "Select a repo first with /repo <name>.");
          return;
        }
        this.runDetached(
          chatId,
          this.executeOrEnqueue("ask", command.instruction, session.selectedRepo, session.mode, chatId, userId),
          "ask_execute_or_enqueue"
        );
        return;
      }
      case "task": {
        if (!session.selectedRepo) {
          await this.deps.telegram.sendMessage(chatId, "Select a repo first with /repo <name>.");
          return;
        }
        this.runDetached(
          chatId,
          this.executeOrEnqueue("task", command.instruction, session.selectedRepo, session.mode, chatId, userId),
          "task_execute_or_enqueue"
        );
        return;
      }
      default: {
        await this.deps.telegram.sendMessage(chatId, "Unknown command. Use /help.");
      }
    }
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

  private async handleRepoInit(
    chatId: number,
    userId: number,
    repoName: string,
    basePathOverride?: string
  ): Promise<void> {
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

  private async registerRepo(
    chatId: number,
    userId: number,
    repoName: string,
    resolvedPath: string,
    eventType: "repo_added" | "repo_initialized"
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
      const prefix = eventType === "repo_initialized" ? "Repo initialized and added" : "Repo added";
      if (eventType === "repo_initialized") {
        this.deps.sessions.setRepo(chatId, added.name);
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
      }

      if (this.deps.persistRepos) {
        try {
          await this.deps.persistRepos(this.deps.repos.list());
        } catch (persistError) {
          this.deps.repos.add(removed);
          if (hadSelectedRepo) {
            this.deps.sessions.setRepo(chatId, removed.name);
          }
          await this.deps.telegram.sendMessage(
            chatId,
            formatError(`Repo removal failed to persist: ${String(persistError)}`)
          );
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

  private async executeOrEnqueue(
    taskType: TaskType,
    instruction: string,
    repoName: string,
    mode: PolicyMode,
    chatId: number,
    userId: number
  ): Promise<void> {
    if (this.executionAdmissionLock.has(chatId)) {
      await this.deps.telegram.sendMessage(chatId, "Another request is currently being scheduled for this chat.");
      return;
    }
    this.executionAdmissionLock.add(chatId);

    try {
      const session = this.deps.sessions.getOrCreate(chatId);
      if (session.activeRequestId) {
        await this.deps.telegram.sendMessage(
          chatId,
          `Request ${session.activeRequestId} is already running. Use /status or /abort first.`
        );
        return;
      }

      const decision = this.deps.policy.decide(mode, taskType);
      const requestId = makeRequestId();

      const instructionDecision = this.deps.instructionPolicy.decide(taskType, instruction);
      if (!instructionDecision.allowed) {
        await this.deps.audit.log({
          type: "policy_block_instruction",
          chatId,
          userId,
          repo: repoName,
          mode,
          taskType,
          requestId,
          reason: instructionDecision.reason,
          matchedPattern: instructionDecision.matchedPattern,
          blockedDomain: instructionDecision.blockedDomain,
          blockedPathPattern: instructionDecision.blockedPathPattern
        });
        await this.deps.telegram.sendMessage(
          chatId,
          formatError(
            instructionDecision.blockedDomain
              ? `Instruction references blocked domain: ${instructionDecision.blockedDomain}`
              : instructionDecision.blockedPathPattern
                ? `Instruction references forbidden path pattern: ${instructionDecision.blockedPathPattern}`
              : `Instruction blocked by policy (${instructionDecision.matchedPattern ?? "pattern"}).`
          )
        );
        return;
      }

      if (taskType === "task" && this.deps.requireAgentsForMutatingTasks) {
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
            `Missing AGENTS.md in repo root (${agentsPath}). Create it before running /task.`
          );
          return;
        }
      }

      if (!decision.allowed) {
        await this.deps.telegram.sendMessage(chatId, formatError(decision.reason ?? "Task blocked by policy."));
        await this.deps.audit.log({
          type: "policy_block",
          chatId,
          userId,
          repo: repoName,
          mode,
          taskType,
          requestId,
          reason: decision.reason
        });
        return;
      }

      if (decision.requiresApproval) {
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
          taskType,
          instruction,
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
          taskType,
          requestId
        });
        await this.deps.telegram.sendMessage(
          chatId,
          formatApprovalPending(requestId, repoName, mode, taskType, toAuditPreview(instruction, 180), {
            requesterUserId: pending.userId,
            createdAt: pending.createdAt
          })
        );
        return;
      }

      await this.executeTask(taskType, instruction, repoName, mode, requestId, userId, chatId);
    } finally {
      this.executionAdmissionLock.delete(chatId);
    }
  }

  private async executeTask(
    taskType: TaskType,
    instruction: string,
    repoName: string,
    mode: PolicyMode,
    requestId: string,
    userId: number,
    chatId: number
  ): Promise<void> {
    let resultSent = false;
    try {
      const repo = this.deps.repos.get(repoName);
      const context: TaskContext = {
        chatId,
        userId,
        repoName,
        mode,
        instruction,
        taskType,
        requestId,
        systemGuidance: this.deps.instructionPolicy.buildExecutionGuidance()
      };

      this.deps.sessions.setActiveRequest(chatId, requestId);
      await this.deps.telegram.sendMessage(chatId, formatTaskStart(repoName, mode, requestId));

      await this.deps.audit.log({
        type: "codex_start",
        requestId,
        chatId,
        userId,
        repo: repoName,
        mode,
        taskType
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

      await this.deps.audit.log({
        type: "codex_finish",
        requestId,
        chatId,
        userId,
        ok: result.ok,
        exitCode: result.exitCode,
        aborted: result.aborted,
        timedOut: result.timedOut,
        summaryPreview: toAuditPreview(result.summary, 400),
        summaryLength: result.summary.length
      });

      await this.deps.telegram.sendMessage(chatId, formatTaskResult(result, repoName, mode));
      resultSent = true;
    } catch (error) {
      await this.deps.audit.log({
        type: "codex_orchestration_error",
        requestId,
        chatId,
        userId,
        error: String(error)
      });
      if (!resultSent) {
        await this.deps.telegram.sendMessage(
          chatId,
          formatError("Internal execution error. Check audit logs for details.")
        );
      }
    } finally {
      this.activeAborts.delete(requestId);
      const session = this.deps.sessions.getOrCreate(chatId);
      if (session.activeRequestId === requestId) {
        this.deps.sessions.setActiveRequest(chatId, undefined);
      }
    }
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
        await this.deps.telegram.sendMessage(
          chatId,
          formatError("Internal scheduling error. Check audit logs for details.")
        );
      } catch (sendError) {
        console.error(`Failed to send detached error message: ${String(sendError)}`);
      }
    });
  }
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
  plainTextMode: PlainTextMode;
  persistRepos?: (repos: RepoConfig[]) => Promise<void>;
  repoInitDefaultParentPath: string;
  initializeRepo?: (repoPath: string) => Promise<void>;
  requireAgentsForMutatingTasks: boolean;
  instructionPolicy: InstructionPolicy;
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
    plainTextMode: params.plainTextMode,
    persistRepos: params.persistRepos,
    repoInitDefaultParentPath: params.repoInitDefaultParentPath,
    initializeRepo: params.initializeRepo,
    requireAgentsForMutatingTasks: params.requireAgentsForMutatingTasks,
    instructionPolicy: params.instructionPolicy
  });
}
