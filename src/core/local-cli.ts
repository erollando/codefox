import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveConfigPath } from "./config.js";
import { buildExternalSessionId } from "./external-session-route.js";
import { FileLocalCommandQueue, defaultLocalCommandQueuePath } from "./local-command-queue.js";
import { JsonStateStore, pruneStateByTtl } from "./state-store.js";
import { approveCurrentRevision, createInitialWorkflow, getCurrentRevision } from "./spec-workflow.js";
import type { PersistedSpecWorkflow, PersistedState } from "./state-store.js";

export interface LocalCliOutput {
  log(line: string): void;
  error(line: string): void;
}

export interface LocalCliParsedArgs {
  command: "help" | "sessions" | "approvals" | "specs" | "session" | "send" | "handoff" | "chat";
  chatId?: number;
  userId?: number;
  text?: string;
  configPath?: string;
  taskId?: string;
  remainingSummary?: string;
  workId?: string;
  completedWork?: string[];
  unresolvedRisks?: string[];
  unresolvedQuestions?: string[];
  clientId?: string;
  specRevisionRef?: string;
  completionSummary?: string;
  sessionId?: string;
  relayHost?: string;
  relayPort?: number;
  leaseSeconds?: number;
  startIfMissingRelay?: boolean;
  repoPath?: string;
}

interface RelayRoutesResponse {
  ok: boolean;
  routes?: Array<{
    sessionId: string;
    chatId: number;
  }>;
  error?: string;
}

interface RelayBindSuccessResponse {
  ok: true;
  lease: {
    leaseId: string;
    schemaVersion: string;
    session: {
      sessionId: string;
    };
  };
}

interface RelayBindErrorResponse {
  ok: false;
  reasonCode?: string;
  reason?: string;
  error?: string;
}

type RelayBindResponse = RelayBindSuccessResponse | RelayBindErrorResponse;

export interface LocalCliParseResult {
  ok: boolean;
  args?: LocalCliParsedArgs;
  error?: string;
}

export function parseLocalCliArgs(argv: string[]): LocalCliParseResult {
  let configPath: string | undefined;
  let userId: number | undefined;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config") {
      const next = argv[index + 1];
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --config."
        };
      }
      configPath = next;
      index += 1;
      continue;
    }
    if (token === "--user") {
      const next = argv[index + 1];
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --user."
        };
      }
      const parsedUserId = Number(next);
      if (!Number.isSafeInteger(parsedUserId) || parsedUserId <= 0) {
        return {
          ok: false,
          error: "userId must be a positive integer."
        };
      }
      userId = parsedUserId;
      index += 1;
      continue;
    }
    positional.push(token);
  }

  const command = positional[0] ?? "help";

  if (command === "help") {
    return {
      ok: true,
      args: {
        command: "help",
        configPath
      }
    };
  }

  if (command === "sessions" || command === "approvals" || command === "specs") {
    return {
      ok: true,
      args: {
        command,
        configPath
      }
    };
  }

  if (command === "chat") {
    const chatIdRaw = positional[1];
    if (!chatIdRaw) {
      return {
        ok: true,
        args: {
          command: "chat",
          userId,
          configPath
        }
      };
    }
    const chatId = Number(chatIdRaw);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      return {
        ok: false,
        error: "chatId must be a positive integer."
      };
    }
    return {
      ok: true,
      args: {
        command: "chat",
        chatId,
        userId,
        configPath
      }
    };
  }

  if (command === "session") {
    const chatIdRaw = positional[1];
    if (!chatIdRaw) {
      return {
        ok: false,
        error: "session command requires <chatId>."
      };
    }
    const chatId = Number(chatIdRaw);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      return {
        ok: false,
        error: "chatId must be a positive integer."
      };
    }
    return {
      ok: true,
      args: {
        command: "session",
        chatId,
        configPath
      }
    };
  }

  if (command === "send") {
    const chatIdRaw = positional[1];
    const text = positional.slice(2).join(" ").trim();
    if (!chatIdRaw) {
      return {
        ok: false,
        error: "send command requires <chatId> <command-text>."
      };
    }
    const chatId = Number(chatIdRaw);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      return {
        ok: false,
        error: "chatId must be a positive integer."
      };
    }
    if (!text) {
      return {
        ok: false,
        error: "send command requires non-empty <command-text>."
      };
    }
    return {
      ok: true,
      args: {
        command: "send",
        chatId,
        userId,
        text,
        configPath
      }
    };
  }

  if (command === "handoff") {
    const handoff = parseHandoffCommand(positional.slice(1));
    if (!handoff.ok || !handoff.args) {
      return {
        ok: false,
        error: handoff.error
      };
    }
    return {
      ok: true,
      args: {
        command: "handoff",
        configPath,
        ...handoff.args
      }
    };
  }

  return {
    ok: false,
    error: `Unknown command '${command}'.`
  };
}

interface HandoffParsedArgs {
  chatId?: number;
  taskId?: string;
  remainingSummary?: string;
  workId?: string;
  completedWork: string[];
  unresolvedRisks: string[];
  unresolvedQuestions: string[];
  clientId?: string;
  specRevisionRef?: string;
  completionSummary?: string;
  sessionId?: string;
  relayHost?: string;
  relayPort?: number;
  leaseSeconds?: number;
  startIfMissingRelay?: boolean;
  repoPath?: string;
}

function parseHandoffCommand(tokens: string[]): { ok: boolean; args?: HandoffParsedArgs; error?: string } {
  let chatId: number | undefined;
  let startIndex = 0;
  const first = tokens[0];
  if (first && !first.startsWith("--")) {
    const parsedChatId = Number(first);
    if (!Number.isSafeInteger(parsedChatId) || parsedChatId <= 0) {
      return {
        ok: false,
        error: "chatId must be a positive integer."
      };
    }
    chatId = parsedChatId;
    startIndex = 1;
  }

  const completedWork: string[] = [];
  const unresolvedRisks: string[] = [];
  const unresolvedQuestions: string[] = [];
  let taskId: string | undefined;
  let remainingSummary: string | undefined;
  let workId: string | undefined;
  let clientId: string | undefined;
  let specRevisionRef: string | undefined;
  let completionSummary: string | undefined;
  let sessionId: string | undefined;
  let relayHost: string | undefined;
  let relayPort: number | undefined;
  let leaseSeconds: number | undefined;
  let startIfMissingRelay: boolean | undefined;
  let repoPath: string | undefined;

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const readRequired = (flag: string): string | undefined => {
      if (!next) {
        return undefined;
      }
      index += 1;
      return next;
    };

    if (token === "--task") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --task."
        };
      }
      taskId = value;
      continue;
    }
    if (token === "--remaining") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --remaining."
        };
      }
      remainingSummary = value;
      continue;
    }
    if (token === "--work-id") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --work-id."
        };
      }
      workId = value;
      continue;
    }
    if (token === "--completed") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --completed."
        };
      }
      completedWork.push(value);
      continue;
    }
    if (token === "--risk") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --risk."
        };
      }
      unresolvedRisks.push(value);
      continue;
    }
    if (token === "--question") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --question."
        };
      }
      unresolvedQuestions.push(value);
      continue;
    }
    if (token === "--client") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --client."
        };
      }
      clientId = value;
      continue;
    }
    if (token === "--spec") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --spec."
        };
      }
      specRevisionRef = value;
      continue;
    }
    if (token === "--completion-summary") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --completion-summary."
        };
      }
      completionSummary = value;
      continue;
    }
    if (token === "--session-id") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --session-id."
        };
      }
      sessionId = value;
      continue;
    }
    if (token === "--host") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --host."
        };
      }
      relayHost = value;
      continue;
    }
    if (token === "--port") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --port."
        };
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return {
          ok: false,
          error: "port must be a positive integer."
        };
      }
      relayPort = parsed;
      continue;
    }
    if (token === "--lease-seconds") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --lease-seconds."
        };
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return {
          ok: false,
          error: "lease seconds must be a positive integer."
        };
      }
      leaseSeconds = parsed;
      continue;
    }
    if (token === "--start-if-missing") {
      startIfMissingRelay = true;
      continue;
    }
    if (token === "--no-start-if-missing") {
      startIfMissingRelay = false;
      continue;
    }
    if (token === "--repo-path") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --repo-path."
        };
      }
      repoPath = value;
      continue;
    }

    return {
      ok: false,
      error: `Unknown handoff option '${token}'.`
    };
  }

  return {
    ok: true,
    args: {
      chatId,
      taskId: taskId?.trim(),
      remainingSummary: remainingSummary?.trim(),
      workId: workId?.trim(),
      completedWork,
      unresolvedRisks,
      unresolvedQuestions,
      clientId: clientId?.trim(),
      specRevisionRef: specRevisionRef?.trim(),
      completionSummary: completionSummary?.trim(),
      sessionId: sessionId?.trim(),
      relayHost: relayHost?.trim(),
      relayPort,
      leaseSeconds,
      startIfMissingRelay,
      repoPath: repoPath?.trim()
    }
  };
}

export async function runLocalCli(argv: string[], output: LocalCliOutput): Promise<number> {
  const parsed = parseLocalCliArgs(argv);
  if (!parsed.ok || !parsed.args) {
    output.error(parsed.error ?? "Invalid arguments.");
    output.log(renderHelp());
    return 1;
  }

  const args = parsed.args;
  if (args.command === "help") {
    output.log(renderHelp());
    return 0;
  }

  const resolvedConfigPath = resolveConfigPath(args.configPath);
  const config = await loadConfig(resolvedConfigPath);

  if (args.command === "handoff") {
    return runLocalHandoff(args, config, output, resolvedConfigPath);
  }

  if (args.command === "chat") {
    return runLocalChat(args, config, output);
  }

  if (args.command === "send") {
    const effectiveUserId = args.userId ?? config.telegram.allowedUserIds[0];
    if (!effectiveUserId) {
      output.error("No allowed user id configured. Use --user <id> or set telegram.allowedUserIds.");
      return 1;
    }

    const queue = new FileLocalCommandQueue(defaultLocalCommandQueuePath(config.state.filePath));
    const queued = await queue.enqueue({
      chatId: args.chatId as number,
      userId: effectiveUserId,
      text: args.text as string
    });
    output.log(
      `Queued local command ${queued.id} for chat ${queued.chatId} user ${queued.userId}: ${queued.text}`
    );
    output.log(`Queue inbox: ${queue.inboxPath()}`);
    return 0;
  }

  const store = new JsonStateStore(config.state.filePath);
  const loaded = await store.load();
  const pruned = pruneStateByTtl(loaded, {
    sessionTtlHours: config.state.sessionTtlHours,
    approvalTtlHours: config.state.approvalTtlHours
  }).state;

  if (args.command === "sessions") {
    output.log(renderSessions(pruned.sessions));
    return 0;
  }

  if (args.command === "approvals") {
    output.log(renderApprovals(pruned.approvals));
    return 0;
  }

  if (args.command === "specs") {
    output.log(renderSpecs(pruned.specWorkflows));
    return 0;
  }

  const session = pruned.sessions.find((entry) => entry.chatId === args.chatId);
  const approval = pruned.approvals.find((entry) => entry.chatId === args.chatId);
  const spec = pruned.specWorkflows.find((entry) => entry.chatId === args.chatId);

  if (!session) {
    output.error(`No session found for chatId ${args.chatId}.`);
    return 1;
  }

  output.log(renderSessionDetail(session, approval, spec));
  return 0;
}

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

async function runLocalHandoff(
  args: LocalCliParsedArgs,
  config: LoadedConfig,
  output: LocalCliOutput,
  resolvedConfigPath: string
): Promise<number> {
  if (!config.externalRelay.enabled) {
    output.error("externalRelay is disabled in config. Enable externalRelay.enabled to use handoff command.");
    return 1;
  }

  const relayHost = args.relayHost ?? config.externalRelay.host;
  const relayPort = args.relayPort ?? config.externalRelay.port;
  const relayBaseUrl = `http://${relayHost}:${relayPort}`;
  const authToken = config.externalRelay.authTokenEnvVar
    ? process.env[config.externalRelay.authTokenEnvVar]
    : undefined;
  if (config.externalRelay.authTokenEnvVar && !authToken) {
    output.error(
      `Missing required relay token env var '${config.externalRelay.authTokenEnvVar}'.`
    );
    return 1;
  }

  const store = new JsonStateStore(config.state.filePath);
  const loaded = await store.load();
  const pruned = pruneStateByTtl(loaded, {
    sessionTtlHours: config.state.sessionTtlHours,
    approvalTtlHours: config.state.approvalTtlHours
  }).state;

  let routesResponse = await requestRelayJson<RelayRoutesResponse>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/routes",
    method: "GET",
    authToken
  });
  if (routesResponse.status === 0) {
    const shouldStart = await shouldStartMissingRelay(args, relayBaseUrl, resolvedConfigPath, output);
    if (shouldStart) {
      output.log(`Starting CodeFox with config ${resolvedConfigPath}...`);
      const startedPid = startCodeFoxProcess(resolvedConfigPath);
      if (typeof startedPid === "number" && startedPid > 0) {
        const stopCommand = process.platform === "win32" ? `taskkill /PID ${startedPid} /F` : `kill ${startedPid}`;
        const pidFilePath = relayPidFilePath(config.state.filePath);
        await persistRelayPid(pidFilePath, startedPid);
        output.log(`Started CodeFox in background (pid ${startedPid}). Stop it with: ${stopCommand}`);
        output.log(`Background pid file: ${pidFilePath}`);
      }
      const ready = await waitForRelayReady(relayBaseUrl, authToken, 10000);
      if (!ready) {
        output.error(`Started CodeFox, but external relay is still unreachable at ${relayBaseUrl}.`);
        return 1;
      }
      routesResponse = await requestRelayJson<RelayRoutesResponse>({
        baseUrl: relayBaseUrl,
        path: "/v1/external-codex/routes",
        method: "GET",
        authToken
      });
    }
  }
  if (!routesResponse.ok || !routesResponse.body?.ok) {
    if (routesResponse.status === 0) {
      output.error(
        [
          `Cannot reach CodeFox external relay at ${relayBaseUrl}.`,
          "Start CodeFox with externalRelay.enabled=true, then retry.",
          config.externalRelay.authTokenEnvVar
            ? `Ensure ${config.externalRelay.authTokenEnvVar} is set and matches the running CodeFox process.`
            : "If relay auth is enabled, provide the matching bearer token env var."
        ].join(" ")
      );
      return 1;
    }
    output.error(renderRelayError("Failed to fetch external relay routes.", routesResponse));
    return 1;
  }
  const routes = routesResponse.body.routes ?? [];

  const selectedRouteSessionId =
    !args.sessionId && typeof args.chatId !== "number"
      ? await chooseRouteForHandoff(pruned.sessions, routes, output)
      : undefined;
  const contextArgs = selectedRouteSessionId ? { ...args, sessionId: selectedRouteSessionId } : args;

  const context = resolveHandoffContext(contextArgs, pruned.sessions, routes);
  if (!context.ok || !context.value) {
    output.error(context.error ?? "Could not resolve handoff context.");
    return 1;
  }
  const { chatId, sessionId, autoSelected } = context.value;
  if (autoSelected) {
    output.log(`Auto-selected session ${sessionId} for chat ${chatId}.`);
  }

  const matchedRoute = routes.find((route) => route.sessionId === sessionId);
  if (!matchedRoute) {
    output.error(
      `Session '${sessionId}' is not currently routed. Set /repo and /mode in Telegram first, then retry.`
    );
    return 1;
  }

  const clientId = args.clientId || "codex-handoff-cli";
  const bindResponse = await requestRelayJson<RelayBindResponse>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/bind",
    method: "POST",
    authToken,
    body: {
      clientId,
      session: { sessionId },
      requestedSchemaVersion: "v1",
      requestedCapabilityClasses: ["completion", "handoff_bundle"],
      ...(typeof args.leaseSeconds === "number" ? { requestedLeaseSeconds: args.leaseSeconds } : {})
    }
  });
  const bindBody = bindResponse.body;
  if (!bindResponse.ok || !bindBody || bindBody.ok !== true) {
    const reason = bindBody && "reason" in bindBody ? bindBody.reason : bindResponse.error;
    output.error(`Bind failed: ${reason ?? "unknown bind error"}.`);
    return 1;
  }

  const leaseId = bindBody.lease.leaseId;
  const schemaVersion = bindBody.lease.schemaVersion;
  const completionEvent = {
    schemaVersion,
    leaseId,
    eventId: `evt_${randomUUID().slice(0, 8)}`,
    clientId,
    timestamp: new Date().toISOString(),
    sequence: 1,
    type: "completion",
    status: "success",
    summary: args.completionSummary || "Execution phase complete in external Codex client"
  };

  const completionResponse = await requestRelayJson<{ decision?: { ok?: boolean; reason?: string } }>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/event",
    method: "POST",
    authToken,
    body: completionEvent
  });
  if (!completionResponse.ok || completionResponse.body?.decision?.ok !== true) {
    await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);
    output.error(renderRelayError("Completion event relay failed.", completionResponse));
    return 1;
  }

  const session = pruned.sessions.find((entry) => entry.chatId === chatId);
  const taskId = resolveTaskId(args, session);
  const remainingSummary = resolveRemainingSummary(args, session);
  const sourceRepo = resolveSourceRepoMetadata(sessionId, args.repoPath, output);
  const specRevisionRef = await resolveOrBootstrapSpecRevisionRef({
    args,
    chatId,
    state: pruned,
    store,
    taskId,
    remainingSummary
  });
  if (!specRevisionRef.ok || !specRevisionRef.value) {
    output.error(specRevisionRef.error ?? "Could not resolve spec revision.");
    return 1;
  }
  if (specRevisionRef.created) {
    output.log(`Auto-created and approved spec ${specRevisionRef.value} for chat ${chatId}.`);
  }
  const workId = args.workId || "rw-1";
  const handoffId = `handoff_${randomUUID().slice(0, 8)}`;
  const handoffResponse = await requestRelayJson<{ decision?: { ok?: boolean; reason?: string } }>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/handoff",
    method: "POST",
    authToken,
    body: {
      schemaVersion,
      leaseId,
      handoffId,
      clientId,
      createdAt: new Date().toISOString(),
      taskId,
      specRevisionRef: specRevisionRef.value,
      completedWork: args.completedWork ?? [],
      remainingWork: [
        {
          id: workId,
          summary: remainingSummary
        }
      ],
      ...(sourceRepo ? { sourceRepo } : {}),
      ...(args.unresolvedQuestions && args.unresolvedQuestions.length > 0
        ? { unresolvedQuestions: args.unresolvedQuestions }
        : {}),
      ...(args.unresolvedRisks && args.unresolvedRisks.length > 0
        ? { unresolvedRisks: args.unresolvedRisks }
        : {})
    }
  });
  if (!handoffResponse.ok || handoffResponse.body?.decision?.ok !== true) {
    await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);
    output.error(renderRelayError("Handoff relay failed.", handoffResponse));
    return 1;
  }

  await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);

  output.log(`Handoff submitted successfully for chat ${chatId}.`);
  output.log(`session: ${sessionId}`);
  output.log(`lease: ${leaseId}`);
  output.log(`handoff id: ${handoffId}`);
  output.log(`task id: ${taskId}${args.taskId ? "" : " (auto-generated)"}`);
  output.log(`spec ref: ${specRevisionRef.value}`);
  output.log(`remaining work: ${workId} (${remainingSummary}${args.remainingSummary ? "" : " (auto-generated)"})`);
  output.log("Next steps in Telegram:");
  output.log("  /handoff show");
  output.log(`  /continue ${workId}`);
  return 0;
}

async function runLocalChat(args: LocalCliParsedArgs, config: LoadedConfig, output: LocalCliOutput): Promise<number> {
  const effectiveUserId = args.userId ?? config.telegram.allowedUserIds[0];
  if (!effectiveUserId) {
    output.error("No allowed user id configured. Use --user <id> or set telegram.allowedUserIds.");
    return 1;
  }

  const store = new JsonStateStore(config.state.filePath);
  const loaded = await store.load();
  const pruned = pruneStateByTtl(loaded, {
    sessionTtlHours: config.state.sessionTtlHours,
    approvalTtlHours: config.state.approvalTtlHours
  }).state;

  let activeChatId = args.chatId;
  if (!activeChatId) {
    const allowedChats = config.telegram.allowedChatIds ?? [];
    if (allowedChats.length === 1) {
      activeChatId = allowedChats[0];
    } else {
      const latestSession = [...pruned.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      activeChatId = latestSession?.chatId;
    }
  }
  if (!activeChatId) {
    output.error("Could not determine target chatId. Pass `chat <chatId>` or configure a single telegram.allowedChatIds entry.");
    return 1;
  }

  const queue = new FileLocalCommandQueue(defaultLocalCommandQueuePath(config.state.filePath));
  const { createInterface } = await import("node:readline/promises");
  const shell = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  output.log(`CodeFox chat shell connected. chat=${activeChatId} user=${effectiveUserId}`);
  output.log("Type /exit to close. Type /chat <id> to switch chat.");
  try {
    while (true) {
      const line = (await shell.question("codefox> ")).trim();
      if (!line) {
        continue;
      }
      if (line === "/exit" || line === "/quit") {
        break;
      }
      if (line.startsWith("/chat ")) {
        const nextChat = Number(line.slice("/chat ".length).trim());
        if (!Number.isSafeInteger(nextChat) || nextChat <= 0) {
          output.error("chat id must be a positive integer.");
          continue;
        }
        activeChatId = nextChat;
        output.log(`Switched to chat ${activeChatId}.`);
        continue;
      }

      const queued = await queue.enqueue({
        chatId: activeChatId,
        userId: effectiveUserId,
        text: line
      });
      output.log(`queued ${queued.id} -> chat ${activeChatId}: ${line}`);
    }
  } finally {
    shell.close();
  }
  return 0;
}

function resolveTaskId(
  args: LocalCliParsedArgs,
  session?: {
    activeRequestId?: string;
    codexThreadId?: string;
  }
): string {
  if (args.taskId && args.taskId.trim().length > 0) {
    return args.taskId.trim();
  }
  if (session?.activeRequestId && session.activeRequestId.trim().length > 0) {
    return `TASK-${session.activeRequestId.trim()}`;
  }
  if (session?.codexThreadId && session.codexThreadId.trim().length > 0) {
    return `TASK-${session.codexThreadId.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20)}`;
  }
  return `TASK-${randomUUID().slice(0, 8)}`;
}

function resolveRemainingSummary(
  args: LocalCliParsedArgs,
  session?: {
    activeRequestId?: string;
    codexThreadId?: string;
  }
): string {
  if (args.remainingSummary && args.remainingSummary.trim().length > 0) {
    return args.remainingSummary.trim();
  }
  if (session?.activeRequestId && session.activeRequestId.trim().length > 0) {
    return `Continue remaining work from request ${session.activeRequestId.trim()}`;
  }
  if (session?.codexThreadId && session.codexThreadId.trim().length > 0) {
    return `Continue remaining work from Codex session ${session.codexThreadId.trim()}`;
  }
  return "Continue remaining handoff work";
}

function resolveHandoffContext(
  args: LocalCliParsedArgs,
  sessions: Array<{
    chatId: number;
    selectedRepo?: string;
    mode: string;
    updatedAt: string;
  }>,
  routes: Array<{
    sessionId: string;
    chatId: number;
  }>
): { ok: boolean; value?: { chatId: number; sessionId: string; autoSelected: boolean }; error?: string } {
  if (args.sessionId && args.sessionId.trim().length > 0) {
    const sessionId = args.sessionId.trim();
    const routed = routes.find((entry) => entry.sessionId === sessionId);
    const parsedChatId = parseChatIdFromSessionId(sessionId);
    const chatId = routed?.chatId ?? args.chatId ?? parsedChatId;
    if (!chatId) {
      return {
        ok: false,
        error: `Could not determine chat id for session '${sessionId}'.`
      };
    }
    return {
      ok: true,
      value: {
        chatId,
        sessionId,
        autoSelected: false
      }
    };
  }

  if (typeof args.chatId === "number") {
    const chatId = args.chatId;
    const routedForChat = routes.filter((route) => route.chatId === chatId);
    if (routedForChat.length > 0) {
      const session = sessions.find((entry) => entry.chatId === chatId);
      if (session?.selectedRepo) {
        const persistedSessionId =
          session.mode === "observe" || session.mode === "active" || session.mode === "full-access"
            ? buildExternalSessionId(chatId, session.selectedRepo, session.mode)
            : undefined;
        if (persistedSessionId) {
          const exactRoute = routedForChat.find((route) => route.sessionId === persistedSessionId);
          if (exactRoute) {
            return {
              ok: true,
              value: {
                chatId,
                sessionId: exactRoute.sessionId,
                autoSelected: false
              }
            };
          }
        }
      }

      const selectedRoute = pickPreferredRoute(routedForChat, sessions);
      return {
        ok: true,
        value: {
          chatId,
          sessionId: selectedRoute.sessionId,
          autoSelected: true
        }
      };
    }

    const session = sessions.find((entry) => entry.chatId === chatId);
    if (!session) {
      return {
        ok: false,
        error: `No persisted session found for chatId ${chatId} and no active relay route.`
      };
    }
    if (!session.selectedRepo) {
      return {
        ok: false,
        error: `Session ${chatId} has no selected repo. Set /repo in Telegram first.`
      };
    }
    if (session.mode !== "observe" && session.mode !== "active" && session.mode !== "full-access") {
      return {
        ok: false,
        error: `Session ${chatId} has invalid mode '${session.mode}'.`
      };
    }
    return {
      ok: true,
      value: {
        chatId,
        sessionId: buildExternalSessionId(chatId, session.selectedRepo, session.mode),
        autoSelected: false
      }
    };
  }

  if (routes.length === 0) {
    return {
      ok: false,
      error: "No external routes are active. Set /repo and /mode in Telegram first."
    };
  }

  const selectedRoute = pickPreferredRoute(routes, sessions);
  return {
    ok: true,
    value: {
      chatId: selectedRoute.chatId,
      sessionId: selectedRoute.sessionId,
      autoSelected: true
    }
  };
}

function resolveSourceRepoMetadata(
  sessionId: string,
  repoPathOverride: string | undefined,
  output: LocalCliOutput
): { name: string; rootPath?: string } | undefined {
  const route = parseRouteSessionId(sessionId);
  if (!route?.repoName) {
    return undefined;
  }
  const resolvedOverride = repoPathOverride?.trim();
  const candidatePath = resolvedOverride ? path.resolve(resolvedOverride) : detectCurrentGitRoot();
  if (!candidatePath) {
    return { name: route.repoName };
  }
  const currentDirName = path.basename(candidatePath);
  const normalizedRepo = normalizeRepoToken(route.repoName);
  const normalizedDir = normalizeRepoToken(currentDirName);
  const likelyMatch = normalizedRepo.length > 0 && normalizedDir.length > 0 && normalizedDir.includes(normalizedRepo);
  if (!likelyMatch) {
    if (resolvedOverride) {
      output.log(
        `Ignoring --repo-path '${candidatePath}' because it does not match source repo '${route.repoName}'.`
      );
    } else {
      output.log(
        `Detected git repo '${candidatePath}', but it does not look like route repo '${route.repoName}'. Sending name-only source metadata.`
      );
    }
    return { name: route.repoName };
  }
  return {
    name: route.repoName,
    rootPath: candidatePath
  };
}

function detectCurrentGitRoot(): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return undefined;
  }
  const trimmed = String(result.stdout ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRepoToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickPreferredRoute(
  routes: Array<{ sessionId: string; chatId: number }>,
  sessions: Array<{ chatId: number; updatedAt: string }>
): { sessionId: string; chatId: number } {
  if (routes.length === 1) {
    return routes[0];
  }
  const ranked = routes
    .map((route) => ({
      route,
      updatedAt: sessions.find((entry) => entry.chatId === route.chatId)?.updatedAt ?? ""
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.route.sessionId.localeCompare(right.route.sessionId));
  return ranked[0]?.route ?? routes[0];
}

async function chooseRouteForHandoff(
  sessions: Array<{ chatId: number; selectedRepo?: string; mode: string; updatedAt: string }>,
  routes: Array<{ sessionId: string; chatId: number }>,
  output: LocalCliOutput
): Promise<string | undefined> {
  if (routes.length <= 1) {
    return undefined;
  }
  const ranked = routes
    .map((route) => ({
      route,
      updatedAt: sessions.find((entry) => entry.chatId === route.chatId)?.updatedAt ?? ""
    }))
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.route.sessionId.localeCompare(right.route.sessionId)
    );
  const defaultRoute = ranked[0]?.route;
  if (!defaultRoute) {
    return undefined;
  }

  const render = ranked.map((entry, index) => {
    const details = parseRouteSessionId(entry.route.sessionId);
    const repo = details?.repoName ?? "(unknown-repo)";
    const mode = details?.mode ?? "(unknown-mode)";
    const marker = index === 0 ? "default" : "";
    return `${index + 1}. chat=${entry.route.chatId} repo=${repo} mode=${mode} updated=${entry.updatedAt || "(unknown)"}${marker ? ` (${marker})` : ""}`;
  });
  output.log("Multiple active CodeFox routes found. Choose a handoff target:");
  for (const line of render) {
    output.log(`  ${line}`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    output.log(`Auto-selecting default route: ${defaultRoute.sessionId}`);
    return defaultRoute.sessionId;
  }
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = (await prompt.question("Route number (Enter for default): ")).trim();
    if (!answer) {
      return defaultRoute.sessionId;
    }
    const index = Number(answer);
    if (!Number.isSafeInteger(index) || index < 1 || index > ranked.length) {
      output.log(`Invalid selection '${answer}', using default route.`);
      return defaultRoute.sessionId;
    }
    return ranked[index - 1].route.sessionId;
  } finally {
    prompt.close();
  }
}

function parseRouteSessionId(sessionId: string): { chatId: number; repoName: string; mode: string } | undefined {
  const match = /^chat:(\d+)\/repo:([^/]+)\/mode:(observe|active|full-access)$/.exec(sessionId);
  if (!match) {
    return undefined;
  }
  return {
    chatId: Number(match[1]),
    repoName: match[2],
    mode: match[3]
  };
}

function parseChatIdFromSessionId(sessionId: string): number | undefined {
  const match = /^chat:(\d+)\/repo:[^/]+\/mode:(observe|active|full-access)$/.exec(sessionId);
  if (!match) {
    return undefined;
  }
  const chatId = Number(match[1]);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    return undefined;
  }
  return chatId;
}

function resolveSpecRevisionRef(
  args: LocalCliParsedArgs,
  chatId: number,
  specWorkflows: PersistedSpecWorkflow[]
): { ok: boolean; value?: string; error?: string } {
  if (args.specRevisionRef && args.specRevisionRef.trim().length > 0) {
    return {
      ok: true,
      value: args.specRevisionRef.trim()
    };
  }
  const spec = specWorkflows.find((entry) => entry.chatId === chatId);
  if (!spec) {
    return {
      ok: false,
      error: `No spec workflow found for chatId ${chatId}. Pass --spec <revision> or create/approve a spec first.`
    };
  }
  const revision = getCurrentRevision(spec.workflow);
  return {
    ok: true,
    value: `v${revision.version}`
  };
}

async function resolveOrBootstrapSpecRevisionRef(params: {
  args: LocalCliParsedArgs;
  chatId: number;
  state: PersistedState;
  store: JsonStateStore;
  taskId: string;
  remainingSummary: string;
}): Promise<{ ok: boolean; value?: string; error?: string; created?: boolean }> {
  const resolved = resolveSpecRevisionRef(params.args, params.chatId, params.state.specWorkflows);
  if (resolved.ok && resolved.value) {
    return resolved;
  }
  if (params.args.specRevisionRef && params.args.specRevisionRef.trim().length > 0) {
    return resolved;
  }

  const autoIntent = `Continue ${params.taskId}: ${params.remainingSummary}`;
  const approvedWorkflow = approveCurrentRevision(createInitialWorkflow(autoIntent));
  const nextSpecWorkflows = [
    ...params.state.specWorkflows.filter((entry) => entry.chatId !== params.chatId),
    {
      chatId: params.chatId,
      workflow: approvedWorkflow
    }
  ];
  const nextState: PersistedState = {
    sessions: params.state.sessions,
    approvals: params.state.approvals,
    specWorkflows: nextSpecWorkflows,
    externalHandoffs: params.state.externalHandoffs
  };
  await params.store.save(nextState);
  params.state.specWorkflows = nextSpecWorkflows;
  const current = getCurrentRevision(approvedWorkflow);
  return {
    ok: true,
    value: `v${current.version}`,
    created: true
  };
}

async function bestEffortRevokeLease(baseUrl: string, authToken: string | undefined, leaseId: string): Promise<void> {
  await requestRelayJson<{ ok?: boolean }>({
    baseUrl,
    path: "/v1/external-codex/revoke",
    method: "POST",
    authToken,
    body: {
      leaseId,
      reason: "handoff submitted"
    }
  });
}

function renderRelayError(message: string, response: JsonRequestResult<unknown>): string {
  const body = response.body;
  const reason =
    body && typeof body === "object" && body !== null
      ? String(
          (body as Record<string, unknown>).reason ??
            (body as Record<string, unknown>).error ??
            (body as Record<string, unknown>).reasonCode ??
            ""
        )
      : "";
  const detail = reason || response.error || "unknown error";
  if (response.status > 0) {
    return `${message} (HTTP ${response.status}) ${detail}`;
  }
  return `${message} ${detail}`;
}

interface JsonRequestResult<T> {
  ok: boolean;
  status: number;
  body?: T;
  error?: string;
}

async function requestRelayJson<T>(options: {
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  authToken?: string;
  body?: unknown;
}): Promise<JsonRequestResult<T>> {
  try {
    const response = await fetch(`${options.baseUrl}${options.path}`, {
      method: options.method,
      headers: {
        ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
        ...(typeof options.body === "undefined" ? {} : { "content-type": "application/json" })
      },
      ...(typeof options.body === "undefined" ? {} : { body: JSON.stringify(options.body) })
    });
    const raw = await response.text();
    let parsed: T | undefined;
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw) as T;
      } catch {
        return {
          ok: response.ok,
          status: response.status,
          error: "Response body was not valid JSON."
        };
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body: parsed
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: String(error)
    };
  }
}

async function shouldStartMissingRelay(
  args: LocalCliParsedArgs,
  relayBaseUrl: string,
  resolvedConfigPath: string,
  output: LocalCliOutput
): Promise<boolean> {
  if (typeof args.startIfMissingRelay === "boolean") {
    return args.startIfMissingRelay;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await prompt.question(
      `CodeFox relay is unreachable at ${relayBaseUrl}. Start CodeFox now with config ${resolvedConfigPath}? [y/N] `
    );
    return /^y(es)?$/i.test(answer.trim());
  } catch (error) {
    output.error(`Could not read relay start confirmation: ${String(error)}`);
    return false;
  } finally {
    prompt.close();
  }
}

function startCodeFoxProcess(resolvedConfigPath: string): number | undefined {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", "dev", "--", resolvedConfigPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  return child.pid;
}

function relayPidFilePath(stateFilePath: string): string {
  const stateDir = path.dirname(path.resolve(stateFilePath));
  return path.join(stateDir, "codefox.dev.pid");
}

async function persistRelayPid(pidFilePath: string, pid: number): Promise<void> {
  try {
    await writeFile(pidFilePath, `${pid}\n`, "utf8");
  } catch {
    // Non-fatal: user still has direct pid and stop command in output.
  }
}

async function waitForRelayReady(baseUrl: string, authToken: string | undefined, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const health = await requestRelayJson<{ ok?: boolean }>({
      baseUrl,
      path: "/health",
      method: "GET",
      authToken
    });
    if (health.ok && health.body?.ok === true) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function renderHelp(): string {
  return [
    "CodeFox local CLI",
    "Usage:",
    "  npm run local:cli -- [--config <path>] sessions",
    "  npm run local:cli -- [--config <path>] approvals",
    "  npm run local:cli -- [--config <path>] specs",
    "  npm run local:cli -- [--config <path>] session <chatId>",
    "  npm run local:cli -- [--config <path>] [--user <id>] chat [chatId]",
    "  npm run local:cli -- [--config <path>] [--user <id>] send <chatId> <command-text>",
    "  npm run local:cli -- [--config <path>] handoff [chatId] [--remaining <summary>] [options]",
    "    options: [--work-id <id>] [--completed <text>]... [--risk <text>]... [--question <text>]...",
    "             [--task <taskId>] [--client <id>] [--spec <revision>] [--completion-summary <text>] [--session-id <id>]",
    "             [--host <relay-host>] [--port <relay-port>] [--lease-seconds <n>] [--repo-path <path>]",
    "             [--start-if-missing|--no-start-if-missing]",
    "  npm run local:cli -- help"
  ].join("\n");
}

function renderSessions(
  sessions: Array<{
    chatId: number;
    selectedRepo?: string;
    mode: string;
    activeRequestId?: string;
    codexThreadId?: string;
    updatedAt: string;
  }>
): string {
  if (sessions.length === 0) {
    return "No active sessions in persisted state.";
  }

  const lines = ["Sessions:"];
  for (const session of sessions) {
    lines.push(
      `- chat=${session.chatId} repo=${session.selectedRepo ?? "(none)"} mode=${session.mode} activeRequest=${session.activeRequestId ?? "none"} thread=${session.codexThreadId ?? "none"} updatedAt=${session.updatedAt}`
    );
  }
  return lines.join("\n");
}

function renderApprovals(
  approvals: Array<{
    id: string;
    chatId: number;
    userId: number;
    repoName: string;
    mode: string;
    capabilityRef?: string;
    source?: "codefox" | "external-codex";
    externalApproval?: {
      leaseId: string;
      approvalKey: string;
    };
    createdAt: string;
  }>
): string {
  if (approvals.length === 0) {
    return "No pending approvals in persisted state.";
  }

  const lines = ["Approvals:"];
  for (const approval of approvals) {
    const externalRef = approval.externalApproval ? ` externalKey=${approval.externalApproval.approvalKey}` : "";
    lines.push(
      `- id=${approval.id} chat=${approval.chatId} user=${approval.userId} repo=${approval.repoName} mode=${approval.mode} source=${approval.source ?? "codefox"} capability=${approval.capabilityRef ?? "(untyped)"}${externalRef} createdAt=${approval.createdAt}`
    );
  }
  return lines.join("\n");
}

function renderSpecs(
  specWorkflows: PersistedSpecWorkflow[]
): string {
  if (specWorkflows.length === 0) {
    return "No spec workflows in persisted state.";
  }

  const lines = ["Specs:"];
  for (const entry of specWorkflows) {
    const revision = getCurrentRevision(entry.workflow);
    lines.push(
      `- chat=${entry.chatId} version=v${revision.version} stage=${revision.stage} status=${revision.status} updatedAt=${revision.updatedAt}`
    );
  }
  return lines.join("\n");
}

function renderSessionDetail(
  session: {
    chatId: number;
    selectedRepo?: string;
    mode: string;
    activeRequestId?: string;
    codexThreadId?: string;
    codexLastActiveAt?: string;
    updatedAt: string;
  },
  approval?: {
    id: string;
    createdAt: string;
    source?: "codefox" | "external-codex";
    externalApproval?: {
      leaseId: string;
      approvalKey: string;
    };
    capabilityRef?: string;
  },
  spec?: PersistedSpecWorkflow
): string {
  const lines = [
    `Session ${session.chatId}:`,
    `repo: ${session.selectedRepo ?? "(none)"}`,
    `mode: ${session.mode}`,
    `active request: ${session.activeRequestId ?? "none"}`,
    `codex thread: ${session.codexThreadId ?? "none"}`,
    `codex last active: ${session.codexLastActiveAt ?? "n/a"}`,
    `updated at: ${session.updatedAt}`
  ];

  if (approval) {
    lines.push(
      `pending approval: ${approval.id} (source=${approval.source ?? "codefox"}, capability=${approval.capabilityRef ?? "(untyped)"}${
        approval.externalApproval ? `, externalKey=${approval.externalApproval.approvalKey}` : ""
      }, createdAt=${approval.createdAt})`
    );
  } else {
    lines.push("pending approval: none");
  }

  if (spec) {
    const revision = getCurrentRevision(spec.workflow);
    lines.push(`current spec: v${revision.version} (${revision.stage}, ${revision.status})`);
  } else {
    lines.push("current spec: none");
  }

  return lines.join("\n");
}
