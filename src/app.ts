import { CodexCliAdapter } from "./adapters/codex.js";
import { TelegramPollingAdapter } from "./adapters/telegram.js";
import { ApprovalStore } from "./core/approval-store.js";
import { AccessControl } from "./core/auth.js";
import { AuditLogger } from "./core/audit-logger.js";
import { loadConfig, persistRepos, resolveConfigPath } from "./core/config.js";
import { CodeFoxController, createControllerFromAdapters } from "./core/controller.js";
import { InstructionPolicy } from "./core/instruction-policy.js";
import { FileLocalCommandQueue, defaultLocalCommandQueuePath } from "./core/local-command-queue.js";
import { PolicyEngine } from "./core/policy.js";
import { RepoRegistry } from "./core/repo-registry.js";
import { SessionManager } from "./core/session-manager.js";
import { SpecPolicyEngine } from "./core/spec-policy.js";
import { JsonStateStore, pruneStateByTtl } from "./core/state-store.js";
import type { TelegramUpdate } from "./adapters/telegram.js";

export interface AppRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createApp(configPath?: string): Promise<AppRuntime> {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const config = await loadConfig(resolvedConfigPath);

  const telegram = new TelegramPollingAdapter(
    config.telegram.token,
    config.telegram.pollingTimeoutSeconds,
    config.telegram.pollIntervalMs,
    config.telegram.discardBacklogOnStart
  );
  const access = new AccessControl(config.telegram.allowedUserIds, config.telegram.allowedChatIds);
  const repos = new RepoRegistry(config.repos);
  const audit = new AuditLogger(
    config.audit.logFilePath,
    process.env.CODEFOX_AUDIT_STDOUT === "1",
    config.audit.maxFileBytes
  );
  const stateStore = new JsonStateStore(config.state.filePath);
  const loadedState = await stateStore.load();
  const pruned = pruneStateByTtl(loadedState, {
    sessionTtlHours: config.state.sessionTtlHours,
    approvalTtlHours: config.state.approvalTtlHours
  });
  const initialState = pruned.state;
  const recoveredActiveRequests = initialState.sessions
    .filter((session) => typeof session.activeRequestId === "string" && session.activeRequestId.length > 0)
    .map((session) => ({ chatId: session.chatId, requestId: session.activeRequestId as string }));

  if (recoveredActiveRequests.length > 0) {
    for (const session of initialState.sessions) {
      session.activeRequestId = undefined;
    }
  }

  if (pruned.removedSessions > 0 || pruned.removedApprovals > 0 || recoveredActiveRequests.length > 0) {
    await stateStore.save(initialState);
  }

  let sessions!: SessionManager;
  let approvals!: ApprovalStore;
  let controller!: CodeFoxController;

  const persistState = async (): Promise<void> => {
    await stateStore.save({
      sessions: sessions.list(),
      approvals: approvals.list(),
      specWorkflows: controller ? controller.listSpecWorkflows() : initialState.specWorkflows
    });
  };

  sessions = new SessionManager(config.policy.defaultMode, initialState.sessions, persistState);
  const policy = new PolicyEngine();
  const specPolicy = new SpecPolicyEngine(config.policy.specPolicy);
  approvals = new ApprovalStore(initialState.approvals, persistState);
  const codex = new CodexCliAdapter(config.codex);
  await codex.ensureAvailable();
  const codexRuntimeInfo = codex.getRuntimeInfo();
  const instructionPolicy = new InstructionPolicy(config.safety.instructionPolicy);
  const localCommandQueue = new FileLocalCommandQueue(defaultLocalCommandQueuePath(config.state.filePath));

  controller = createControllerFromAdapters({
    telegram,
    access,
    repos,
    sessions,
    policy,
    approvals,
    audit,
    codex,
    persistRepos: async (repos) => persistRepos(resolvedConfigPath, repos),
    repoInitDefaultParentPath: config.repoInit.defaultParentPath,
    requireAgentsForRuns: config.safety.requireAgentsForRuns,
    instructionPolicy,
    codexSessionIdleMinutes: config.state.codexSessionIdleMinutes,
    codexDefaultReasoningEffort: config.codex.reasoningEffort,
    initialSpecWorkflows: initialState.specWorkflows,
    persistState,
    specPolicy
  });

  let started = false;
  let stopped = false;

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }
      started = true;

      if (pruned.removedSessions > 0 || pruned.removedApprovals > 0) {
        await audit.log({
          type: "state_pruned",
          removedSessions: pruned.removedSessions,
          removedApprovals: pruned.removedApprovals,
          sessionTtlHours: config.state.sessionTtlHours,
          approvalTtlHours: config.state.approvalTtlHours
        });
      }

      if (recoveredActiveRequests.length > 0) {
        await audit.log({
          type: "state_active_requests_cleared",
          clearedCount: recoveredActiveRequests.length,
          clearedRequests: recoveredActiveRequests
        });
      }

      await audit.log({
        type: "service_start",
        repos: config.repos.map((repo) => repo.name),
        defaultMode: config.policy.defaultMode,
        codexSessionIdleMinutes: config.state.codexSessionIdleMinutes,
        codexVersionRaw: codexRuntimeInfo.codexVersionRaw,
        codexVersion: codexRuntimeInfo.codexVersion
      });

      if (codexRuntimeInfo.codexVersionWarning) {
        await audit.log({
          type: "codex_version_compatibility_warning",
          warning: codexRuntimeInfo.codexVersionWarning,
          codexVersionRaw: codexRuntimeInfo.codexVersionRaw,
          codexVersion: codexRuntimeInfo.codexVersion
        });
      }

      await localCommandQueue.start(async (command) => {
        await audit.log({
          type: "local_command_received",
          commandId: command.id,
          chatId: command.chatId,
          userId: command.userId,
          source: command.source
        });
        try {
          await controller.handleUpdate(buildLocalCommandUpdate(command));
          await audit.log({
            type: "local_command_processed",
            commandId: command.id,
            chatId: command.chatId,
            userId: command.userId
          });
        } catch (error) {
          await audit.log({
            type: "local_command_failed",
            commandId: command.id,
            chatId: command.chatId,
            userId: command.userId,
            error: String(error)
          });
          throw error;
        }
      });
      await telegram.start((update) => controller.handleUpdate(update));
    },
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      localCommandQueue.stop();
      const shutdown = await controller.shutdown();
      telegram.stop();
      await stateStore.flush();
      await audit.log({
        type: "service_stop",
        abortedActiveRequests: shutdown.abortedRequestIds,
        pendingActiveRequestsAfterStop: shutdown.pendingRequestIds
      });
    }
  };
}

function buildLocalCommandUpdate(command: { id: string; chatId: number; userId: number; text: string }): TelegramUpdate {
  return {
    update_id: Number.parseInt(command.id.replace(/\D/g, "").slice(0, 9) || "1", 10),
    message: {
      message_id: Number.parseInt(command.id.replace(/\D/g, "").slice(0, 9) || "1", 10),
      text: command.text,
      from: {
        id: command.userId
      },
      chat: {
        id: command.chatId
      }
    }
  };
}

export async function runApp(configPath?: string): Promise<void> {
  const app = await createApp(configPath);
  await app.start();
}
