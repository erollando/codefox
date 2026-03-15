import { CodexCliAdapter } from "./adapters/codex.js";
import { ExternalRelayHttpServer } from "./adapters/external-relay-http.js";
import { TelegramPollingAdapter } from "./adapters/telegram.js";
import { ApprovalStore } from "./core/approval-store.js";
import { AccessControl } from "./core/auth.js";
import { AuditLogger } from "./core/audit-logger.js";
import { loadConfig, persistRepos, resolveConfigPath } from "./core/config.js";
import { CodeFoxController, createControllerFromAdapters } from "./core/controller.js";
import { ExternalCodexRelay } from "./core/external-codex-relay.js";
import { deriveExternalRoutes } from "./core/external-session-route.js";
import { InstructionPolicy } from "./core/instruction-policy.js";
import { RssCodexChangelogTracker } from "./core/codex-changelog.js";
import { FileLocalCommandQueue, defaultLocalCommandQueuePath } from "./core/local-command-queue.js";
import { LocalChatLog, defaultLocalChatLogPath } from "./core/local-chat-log.js";
import { PolicyEngine } from "./core/policy.js";
import { RepoRegistry } from "./core/repo-registry.js";
import { SessionManager } from "./core/session-manager.js";
import { SpecPolicyEngine } from "./core/spec-policy.js";
import { JsonStateStore, pruneStateByTtl } from "./core/state-store.js";
import type { TelegramAdapter, TelegramSendOptions, TelegramUpdate } from "./adapters/telegram.js";

export interface AppRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createApp(configPath?: string): Promise<AppRuntime> {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const config = await loadConfig(resolvedConfigPath);

  const rawTelegram = new TelegramPollingAdapter(
    config.telegram.token,
    config.telegram.pollingTimeoutSeconds,
    config.telegram.pollIntervalMs,
    config.telegram.discardBacklogOnStart
  );
  const localChatLog = new LocalChatLog(
    defaultLocalChatLogPath(config.state.filePath),
    config.state.chatLogMaxFileBytes ?? 2 * 1024 * 1024
  );
  const telegram: TelegramAdapter = {
    start: async (onUpdate) =>
      rawTelegram.start(async (update) => {
        const incoming = extractIncomingText(update);
        if (incoming) {
          await safeAppendLocalChatLog(localChatLog, {
            chatId: incoming.chatId,
            userId: incoming.userId,
            direction: "inbound",
            channel: "telegram",
            text: incoming.text
          });
        }
        await onUpdate(update);
      }),
    stop: () => rawTelegram.stop(),
    sendMessage: async (chatId: number, text: string, options?: TelegramSendOptions) => {
      await rawTelegram.sendMessage(chatId, text, options);
      await safeAppendLocalChatLog(localChatLog, {
        chatId,
        direction: "outbound",
        channel: "telegram",
        text,
        commandButtons: options?.commandButtons
      });
    },
    downloadFile: (fileId, metadata) => rawTelegram.downloadFile(fileId, metadata)
  };
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
      specWorkflows: controller ? controller.listSpecWorkflows() : initialState.specWorkflows,
      externalHandoffs: controller ? controller.listExternalHandoffs() : initialState.externalHandoffs,
      codexChangelog: controller ? controller.getCodexChangelogState() : initialState.codexChangelog
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
  let started = false;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  const stopInternal = async (reason: string, requestedBy?: { chatId: number; userId: number }): Promise<void> => {
    if (stopped) {
      return stopPromise ?? Promise.resolve();
    }
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async () => {
      stopped = true;
      localCommandQueue.stop();
      if (externalRelayHttpServer) {
        await externalRelayHttpServer.stop();
        await audit.log({
          type: "external_relay_http_stopped"
        });
      }
      const shutdown = await controller.shutdown();
      telegram.stop();
      await stateStore.flush();
      await audit.log({
        type: "service_stop",
        reason,
        requestedBy,
        abortedActiveRequests: shutdown.abortedRequestIds,
        pendingActiveRequestsAfterStop: shutdown.pendingRequestIds
      });
    })();
    return stopPromise;
  };

  const externalRelay = new ExternalCodexRelay({
    audit,
    notify: (chatId, message) => telegram.sendMessage(chatId, message),
    onApprovalRequested: async (event) => {
      const session = sessions.getOrCreate(event.chatId);
      const repoName = session.selectedRepo;
      if (!repoName) {
        await audit.log({
          type: "external_approval_request_unbound",
          leaseId: event.leaseId,
          chatId: event.chatId,
          approvalKey: event.approvalKey
        });
        return;
      }

      const pendingId = `extapr_${event.leaseId.slice(-6)}_${event.approvalKey}`;
      approvals.set({
        id: pendingId,
        chatId: event.chatId,
        userId: config.telegram.allowedUserIds[0] ?? 1,
        repoName,
        mode: session.mode,
        instruction: event.summary,
        capabilityRef: event.requestedCapabilityRef,
        source: "external-codex",
        externalApproval: {
          leaseId: event.leaseId,
          approvalKey: event.approvalKey
        },
        createdAt: new Date().toISOString()
      });
      await audit.log({
        type: "external_approval_request_relayed",
        leaseId: event.leaseId,
        chatId: event.chatId,
        approvalKey: event.approvalKey,
        requestedCapabilityRef: event.requestedCapabilityRef
      });
    },
    onCompletionReported: async (event) => {
      await controller.noteExternalCompletion(event.chatId, event.leaseId, event.completion, event.sessionId);
    },
    onHandoffReceived: async (event) => {
      const ingest = await controller.ingestExternalHandoff(
        event.chatId,
        event.leaseId,
        event.handoff,
        event.sessionId,
        event.latestCompletion
      );
      if (!ingest.accepted) {
        await telegram.sendMessage(
          event.chatId,
          `External handoff ${event.handoff.handoffId} rejected: ${ingest.reason ?? "validation failed"}.`
        );
      }
    }
  });
  const externalRelayAuthToken = config.externalRelay.authTokenEnvVar
    ? process.env[config.externalRelay.authTokenEnvVar]
    : undefined;
  const externalRelayHttpServer = config.externalRelay.enabled
    ? new ExternalRelayHttpServer({
        relay: externalRelay,
        host: config.externalRelay.host,
        port: config.externalRelay.port,
        authToken: externalRelayAuthToken,
        getRoutes: () => deriveExternalRoutes(sessions.list())
      })
    : undefined;

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
    initialExternalHandoffs: initialState.externalHandoffs,
    initialCodexChangelogState: initialState.codexChangelog,
    persistState,
    specPolicy,
    codexChangelogTracker: new RssCodexChangelogTracker(),
    externalApprovalDecision: async ({ leaseId, approvalKey, approved, userId }) => {
      const result = await externalRelay.decideApproval(leaseId, approvalKey, approved, userId);
      return Boolean(result);
    },
    requestServiceStop: async ({ chatId, userId }) => {
      if (stopped) {
        return false;
      }
      setTimeout(() => {
        void stopInternal("telegram_service_stop", { chatId, userId });
      }, 25);
      return true;
    }
  });

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

      if (config.externalRelay.enabled && config.externalRelay.authTokenEnvVar && !externalRelayAuthToken) {
        throw new Error(
          `externalRelay.authTokenEnvVar '${config.externalRelay.authTokenEnvVar}' is set but the environment variable is missing.`
        );
      }

      if (externalRelayHttpServer) {
        const address = await externalRelayHttpServer.start();
        await audit.log({
          type: "external_relay_http_started",
          host: address.host,
          port: address.port,
          authEnabled: Boolean(externalRelayAuthToken)
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
        await safeAppendLocalChatLog(localChatLog, {
          chatId: command.chatId,
          userId: command.userId,
          direction: "inbound",
          channel: "local",
          text: command.text
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
      await stopInternal("host_stop");
    }
  };
}

function extractIncomingText(update: TelegramUpdate): { chatId: number; userId?: number; text: string } | undefined {
  const message = update.message;
  if (!message || typeof message.chat?.id !== "number") {
    return undefined;
  }
  const text = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }
  return {
    chatId: message.chat.id,
    userId: typeof message.from?.id === "number" ? message.from.id : undefined,
    text: normalized
  };
}

async function safeAppendLocalChatLog(
  localChatLog: LocalChatLog,
  entry: {
    chatId: number;
    userId?: number;
    direction: "inbound" | "outbound";
    channel: "telegram" | "local";
    text: string;
    commandButtons?: string[];
  }
): Promise<void> {
  try {
    await localChatLog.append(entry);
  } catch (error) {
    console.error(`Local chat log append failure: ${String(error)}`);
  }
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
