import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveConfigPath } from "./config.js";
import { stopOwnedCodeFoxProcess } from "./dev-runtime.js";
import { buildExternalSessionId } from "./external-session-route.js";
import { FileLocalCommandQueue, defaultLocalCommandQueuePath } from "./local-command-queue.js";
import { JsonStateStore, pruneStateByTtl } from "./state-store.js";
import { approveCurrentRevision, createInitialWorkflow, getCurrentRevision } from "./spec-workflow.js";
import { areSemanticallyEquivalentExternalHandoffs } from "./external-handoff-idempotency.js";
import type { PersistedSpecWorkflow, PersistedState } from "./state-store.js";

export interface LocalCliOutput {
  log(line: string): void;
  error(line: string): void;
}

export interface LocalCliParsedArgs {
  command:
    | "help"
    | "dashboard"
    | "sessions"
    | "approvals"
    | "specs"
    | "session"
    | "send"
    | "handoff"
    | "approve"
    | "deny"
    | "continue"
    | "status"
    | "stop";
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
  relayStartMode?: RelayStartMode;
  repoPath?: string;
  watch?: boolean;
}

type RelayStartMode = "foreground" | "background";
type MissingRelayStartModeDecision = RelayStartMode | "none" | "prompt";

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

interface RelayDeliveryResponse {
  decision?: {
    ok?: boolean;
    reasonCode?: string;
    reason?: string;
  };
  relayed?: boolean;
  error?: string;
}

export interface LocalCliParseResult {
  ok: boolean;
  args?: LocalCliParsedArgs;
  error?: string;
}

export function parseLocalCliArgs(argv: string[]): LocalCliParseResult {
  let configPath: string | undefined;
  let userId: number | undefined;
  let watch = false;
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
    if (token === "--watch") {
      watch = true;
      continue;
    }
    positional.push(token);
  }

  const command = positional[0] ?? "help";
  if (watch && command !== "dashboard") {
    return {
      ok: false,
      error: "--watch is only supported with the dashboard command."
    };
  }

  if (command === "help") {
    return {
      ok: true,
      args: {
        command: "help"
      }
    };
  }

  if (command === "dashboard" || command === "sessions" || command === "approvals" || command === "specs" || command === "stop") {
    return {
      ok: true,
      args: {
        command,
        configPath,
        watch: command === "dashboard" ? watch : undefined
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

  if (
    command === "approve" ||
    command === "deny" ||
    command === "status"
  ) {
    const chatIdRaw = positional[1];
    if (!chatIdRaw) {
      return {
        ok: true,
        args: {
          command,
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
        command,
        chatId,
        userId,
        configPath
      }
    };
  }

  if (command === "continue") {
    const first = positional[1];
    const second = positional[2];
    const third = positional[3];
    if (third) {
      return {
        ok: false,
        error: "continue command accepts at most [chatId] [workId]."
      };
    }

    let chatId: number | undefined;
    let workId: string | undefined;
    if (first) {
      const parsedChatId = Number(first);
      if (Number.isSafeInteger(parsedChatId) && parsedChatId > 0) {
        chatId = parsedChatId;
        workId = second?.trim() || undefined;
      } else {
        if (second) {
          return {
            ok: false,
            error: "continue command format is: continue [chatId] [workId] or continue [workId]."
          };
        }
        workId = first.trim();
      }
    }

    return {
      ok: true,
      args: {
        command: "continue",
        chatId,
        userId,
        configPath,
        workId
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
  relayStartMode?: RelayStartMode;
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
  let relayStartMode: RelayStartMode | undefined;
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
      relayStartMode = "background";
      continue;
    }
    if (token === "--no-start-if-missing") {
      startIfMissingRelay = false;
      relayStartMode = undefined;
      continue;
    }
    if (token === "--start-in-foreground") {
      startIfMissingRelay = true;
      relayStartMode = "foreground";
      continue;
    }
    if (token === "--start-in-background") {
      startIfMissingRelay = true;
      relayStartMode = "background";
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
      relayStartMode,
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

  if (args.command === "stop") {
    return stopCodeFoxProcess(config.state.filePath, resolvedConfigPath, output);
  }

  if (args.command === "dashboard") {
    return runLocalDashboard(args, config, output);
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

  if (
    args.command === "approve" ||
    args.command === "deny" ||
    args.command === "continue" ||
    args.command === "status"
  ) {
    const effectiveUserId = args.userId ?? config.telegram.allowedUserIds[0];
    if (!effectiveUserId) {
      output.error("No allowed user id configured. Use --user <id> or set telegram.allowedUserIds.");
      return 1;
    }

    const resolved = resolveDefaultChatId(args.chatId, config, pruned.sessions);
    if (!resolved.chatId) {
      output.error("Could not determine target chatId. Pass <chatId> or configure a single telegram.allowedChatIds entry.");
      return 1;
    }
    if (resolved.autoSelected) {
      output.log(`Auto-selected chat ${resolved.chatId}.`);
    }

    const text =
      args.command === "approve"
        ? "/approve"
        : args.command === "deny"
          ? "/deny"
          : args.command === "status"
            ? "/status"
            : args.workId
              ? `/continue ${args.workId}`
              : "/continue";

    const queue = new FileLocalCommandQueue(defaultLocalCommandQueuePath(config.state.filePath));
    const queued = await queue.enqueue({
      chatId: resolved.chatId,
      userId: effectiveUserId,
      text
    });
    output.log(
      `Queued local command ${queued.id} for chat ${queued.chatId} user ${queued.userId}: ${queued.text}`
    );
    output.log(`Queue inbox: ${queue.inboxPath()}`);
    return 0;
  }

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

async function runLocalDashboard(args: LocalCliParsedArgs, config: LoadedConfig, output: LocalCliOutput): Promise<number> {
  const renderSnapshot = async (): Promise<string> => {
    const store = new JsonStateStore(config.state.filePath);
    const loaded = await store.load();
    const pruned = pruneStateByTtl(loaded, {
      sessionTtlHours: config.state.sessionTtlHours,
      approvalTtlHours: config.state.approvalTtlHours
    }).state;
    return renderDashboard(pruned.sessions, pruned.approvals, pruned.specWorkflows);
  };

  if (!args.watch) {
    output.log(await renderSnapshot());
    return 0;
  }

  if (!process.stdout.isTTY) {
    output.error("dashboard --watch requires an interactive TTY. Run without --watch for a one-shot snapshot.");
    return 1;
  }

  let stopped = false;
  const onStop = () => {
    stopped = true;
  };
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  try {
    while (!stopped) {
      const snapshot = await renderSnapshot();
      process.stdout.write("\x1bc");
      process.stdout.write(`${snapshot}\n\n(press Ctrl+C to exit)\n`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
  }
  return 0;
}

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

function resolveDefaultChatId(
  explicitChatId: number | undefined,
  config: LoadedConfig,
  sessions: Array<{ chatId: number; updatedAt: string }>
): { chatId?: number; autoSelected: boolean } {
  if (explicitChatId) {
    return { chatId: explicitChatId, autoSelected: false };
  }
  const allowedChats = config.telegram.allowedChatIds ?? [];
  if (allowedChats.length === 1) {
    return { chatId: allowedChats[0], autoSelected: true };
  }
  const latestSession = [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return { chatId: latestSession?.chatId, autoSelected: Boolean(latestSession?.chatId) };
}

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
  let foregroundChild: ChildProcess | undefined;
  let startedBackgroundPid: number | undefined;

  try {
    let routesResponse = await requestRelayJson<RelayRoutesResponse>({
      baseUrl: relayBaseUrl,
      path: "/v1/external-codex/routes",
      method: "GET",
      authToken
    });
    if (routesResponse.status === 0) {
      const startMode = await resolveMissingRelayStartMode(args, relayBaseUrl, resolvedConfigPath, output);
      if (startMode !== "none") {
        output.log(
          startMode === "foreground"
            ? `Starting CodeFox in foreground with config ${resolvedConfigPath}...`
            : `Starting CodeFox in background with config ${resolvedConfigPath}...`
        );
        if (startMode === "foreground") {
          foregroundChild = startCodeFoxProcessForeground(resolvedConfigPath);
        } else {
          const startedPid = startCodeFoxProcessBackground(resolvedConfigPath);
          if (typeof startedPid === "number" && startedPid > 0) {
            startedBackgroundPid = startedPid;
            const directStopCommand = process.platform === "win32" ? `taskkill /PID ${startedPid} /F` : `kill ${startedPid}`;
            const pidFilePath = relayPidFilePath(config.state.filePath);
            await persistRelayPid(pidFilePath, startedPid);
            output.log(
              `Started CodeFox in background (pid ${startedPid}). Stop it with: npm run dev:stop -- --config ${resolvedConfigPath}`
            );
            output.log(`Direct PID stop (platform-specific): ${directStopCommand}`);
            output.log(`Background pid file: ${pidFilePath}`);
            output.log(`For a Ctrl+C-managed run instead, use: npm run dev -- ${resolvedConfigPath}`);
          }
        }
        const ready = await waitForRelayReady(relayBaseUrl, authToken, 10000);
        if (!ready) {
          output.error(`Started CodeFox, but external relay is still unreachable at ${relayBaseUrl}.`);
          return finalizeForegroundRelayStart(1, foregroundChild, output);
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
        return finalizeForegroundRelayStart(1, foregroundChild, output);
      }
      output.error(renderRelayError("Failed to fetch external relay routes.", routesResponse));
      return finalizeForegroundRelayStart(1, foregroundChild, output);
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
      return finalizeForegroundRelayStart(1, foregroundChild, output);
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
      return finalizeForegroundRelayStart(1, foregroundChild, output);
    }

    const clientId = args.clientId || "codex-handoff-cli";
    const session = pruned.sessions.find((entry) => entry.chatId === chatId);
    const existingHandoff = findExistingHandoffSnapshot(pruned, chatId, sessionId);
    const taskId = resolveTaskId(args, session, existingHandoff?.handoff.taskId);
    const remainingSummary = resolveRemainingSummary(args, session, existingHandoff?.handoff.remainingWork[0]?.summary);
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
      return finalizeForegroundRelayStart(1, foregroundChild, output);
    }
    if (specRevisionRef.created) {
      output.log(`Auto-created and approved spec ${specRevisionRef.value} for chat ${chatId}.`);
    }
    const workId = resolveWorkId(args, existingHandoff?.handoff.remainingWork[0]?.id);
    const handoffTemplate = {
    schemaVersion: "v1",
    clientId,
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
    ...(args.unresolvedRisks && args.unresolvedRisks.length > 0 ? { unresolvedRisks: args.unresolvedRisks } : {})
  };
    const isEquivalentHandoff = areSemanticallyEquivalentExternalHandoffs(
      existingHandoff
        ? {
            sourceSessionId: existingHandoff.sourceSessionId,
            bundle: existingHandoff.handoff
          }
        : undefined,
      {
        sourceSessionId: sessionId,
        bundle: handoffTemplate
      }
    );
    const shouldResendEquivalentHandoff = isEquivalentHandoff;
    if (shouldResendEquivalentHandoff) {
      output.log(`Handoff already up to date for chat ${chatId}; re-sending reminder to routed clients.`);
    }

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
      return finalizeForegroundRelayStart(1, foregroundChild, output);
    }

    const leaseId = bindBody.lease.leaseId;
    const schemaVersion = bindBody.lease.schemaVersion;
    if (!shouldResendEquivalentHandoff) {
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

      const completionResponse = await requestRelayJson<RelayDeliveryResponse>({
        baseUrl: relayBaseUrl,
        path: "/v1/external-codex/event",
        method: "POST",
        authToken,
        body: completionEvent
      });
      if (!completionResponse.ok || completionResponse.body?.decision?.ok !== true) {
        await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);
        output.error(renderRelayError("Completion event relay failed.", completionResponse));
        return finalizeForegroundRelayStart(1, foregroundChild, output);
      }
      if (completionResponse.body?.relayed !== true) {
        await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);
        output.error(
          "Completion event was accepted but not delivered to a routed chat session. Ensure the target /repo and /mode session is still active, then retry."
        );
        return finalizeForegroundRelayStart(1, foregroundChild, output);
      }
    }

    const handoffId = `handoff_${randomUUID().slice(0, 8)}`;
    const handoffResponse = await requestRelayJson<RelayDeliveryResponse>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/handoff",
    method: "POST",
    authToken,
    body: {
      ...handoffTemplate,
      schemaVersion,
      leaseId,
      handoffId,
      createdAt: new Date().toISOString()
    }
  });
    if (!handoffResponse.ok || handoffResponse.body?.decision?.ok !== true) {
      await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);
      output.error(renderRelayError("Handoff relay failed.", handoffResponse));
      return finalizeForegroundRelayStart(1, foregroundChild, output);
    }
    if (handoffResponse.body?.relayed !== true) {
      await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);
      output.error(
        "Handoff was accepted but not delivered to a routed chat session. Ensure the target /repo and /mode session is still active, then retry."
      );
      return finalizeForegroundRelayStart(1, foregroundChild, output);
    }

    await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);

    output.log(
      shouldResendEquivalentHandoff
        ? `Handoff reminder submitted successfully for chat ${chatId}.`
        : `Handoff submitted successfully for chat ${chatId}.`
    );
    output.log(`session: ${sessionId}`);
    output.log(`lease: ${leaseId}`);
    output.log(`handoff id: ${handoffId}`);
    output.log(`task id: ${taskId}${args.taskId ? "" : " (auto-generated)"}`);
    output.log(`spec ref: ${specRevisionRef.value}`);
    output.log(`remaining work: ${workId} (${remainingSummary}${args.remainingSummary ? "" : " (auto-generated)"})`);
    logTelegramHandoffNextSteps(output, true);
    return finalizeForegroundRelayStart(0, foregroundChild, output);
  } finally {
    if (startedBackgroundPid) {
      output.log(`Stopping auto-started CodeFox (pid ${startedBackgroundPid}).`);
      await stopOwnedCodeFoxProcess({
        pid: startedBackgroundPid,
        stateFilePath: config.state.filePath
      });
    }
  }
}

function logTelegramHandoffNextSteps(output: LocalCliOutput, acceptanceContinuesImmediately: boolean): void {
  output.log("Next steps in Telegram:");
  output.log("  /accept");
  output.log("  /handoff show (optional)");
  if (acceptanceContinuesImmediately) {
    output.log("  After acceptance, CodeFox can continue immediately.");
  }
}

function resolveTaskId(
  args: LocalCliParsedArgs,
  session?: {
    activeRequestId?: string;
    codexThreadId?: string;
  },
  existingTaskId?: string
): string {
  if (args.taskId && args.taskId.trim().length > 0) {
    return args.taskId.trim();
  }
  if (existingTaskId && existingTaskId.trim().length > 0) {
    return existingTaskId.trim();
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
  },
  existingSummary?: string
): string {
  if (args.remainingSummary && args.remainingSummary.trim().length > 0) {
    return args.remainingSummary.trim();
  }
  if (existingSummary && existingSummary.trim().length > 0) {
    return existingSummary.trim();
  }
  if (session?.activeRequestId && session.activeRequestId.trim().length > 0) {
    return `Continue remaining work from request ${session.activeRequestId.trim()}`;
  }
  if (session?.codexThreadId && session.codexThreadId.trim().length > 0) {
    return `Continue remaining work from Codex session ${session.codexThreadId.trim()}`;
  }
  return "Continue remaining handoff work";
}

function resolveWorkId(args: LocalCliParsedArgs, existingWorkId?: string): string {
  if (args.workId && args.workId.trim().length > 0) {
    return args.workId.trim();
  }
  if (existingWorkId && existingWorkId.trim().length > 0) {
    return existingWorkId.trim();
  }
  return "rw-1";
}

function findExistingHandoffSnapshot(
  state: PersistedState,
  chatId: number,
  sessionId: string
): PersistedState["externalHandoffs"][number] | undefined {
  return state.externalHandoffs.find(
    (entry) => entry.chatId === chatId && (entry.sourceSessionId?.trim() || "") === sessionId.trim()
  );
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

export function determineMissingRelayStartMode(
  args: Pick<LocalCliParsedArgs, "startIfMissingRelay" | "relayStartMode">,
  interactiveTerminal: boolean
): MissingRelayStartModeDecision {
  if (args.startIfMissingRelay === false) {
    return "none";
  }
  if (args.relayStartMode) {
    return args.relayStartMode;
  }
  if (args.startIfMissingRelay === true) {
    return "background";
  }
  return interactiveTerminal ? "prompt" : "none";
}

export function parseMissingRelayStartPromptAnswer(answer: string): RelayStartMode | "none" {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "" || normalized === "f" || normalized === "fg" || normalized === "foreground") {
    return "foreground";
  }
  if (normalized === "b" || normalized === "bg" || normalized === "background") {
    return "background";
  }
  return "none";
}

async function resolveMissingRelayStartMode(
  args: LocalCliParsedArgs,
  relayBaseUrl: string,
  resolvedConfigPath: string,
  output: LocalCliOutput
): Promise<RelayStartMode | "none"> {
  const requestedMode = determineMissingRelayStartMode(
    args,
    Boolean(process.stdin.isTTY && process.stdout.isTTY)
  );
  if (requestedMode !== "prompt") {
    return requestedMode;
  }
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await prompt.question(
      `CodeFox relay is unreachable at ${relayBaseUrl}. Start CodeFox now with config ${resolvedConfigPath}? [F/b/N] `
    );
    return parseMissingRelayStartPromptAnswer(answer);
  } catch (error) {
    output.error(`Could not read relay start confirmation: ${String(error)}`);
    return "none";
  } finally {
    prompt.close();
  }
}

function startCodeFoxProcessForeground(resolvedConfigPath: string): ChildProcess {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawn(npmCommand, ["run", "dev", "--", resolvedConfigPath], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
}

function startCodeFoxProcessBackground(resolvedConfigPath: string): number | undefined {
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

async function finalizeForegroundRelayStart(
  exitCode: number,
  foregroundChild: ChildProcess | undefined,
  output: LocalCliOutput
): Promise<number> {
  if (!foregroundChild) {
    return exitCode;
  }
  if (exitCode !== 0) {
    output.log("Stopping foreground CodeFox because handoff did not complete.");
    await stopForegroundChild(foregroundChild);
    return exitCode;
  }
  output.log("CodeFox is running in this terminal. Press Ctrl+C to stop it.");
  return waitForForegroundChildExit(foregroundChild, output);
}

async function stopForegroundChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGINT");
  } catch {
    return;
  }
  const exited = await waitForChildExit(child, 3000);
  if (exited) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await waitForChildExit(child, 2000);
}

async function waitForForegroundChildExit(child: ChildProcess, output: LocalCliOutput): Promise<number> {
  return new Promise<number>((resolve) => {
    let finished = false;
    let stopRequested = false;
    const finish = (code: number): void => {
      if (finished) {
        return;
      }
      finished = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      child.off("exit", onExit);
      resolve(code);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (signal === "SIGINT") {
        finish(130);
        return;
      }
      if (signal === "SIGTERM") {
        finish(143);
        return;
      }
      finish(code ?? 0);
    };
    const requestStop = (signal: NodeJS.Signals): void => {
      if (stopRequested) {
        return;
      }
      stopRequested = true;
      output.log("Stopping foreground CodeFox...");
      try {
        child.kill(signal);
      } catch {
        finish(signal === "SIGINT" ? 130 : 143);
      }
    };
    const onSigint = (): void => {
      requestStop("SIGINT");
    };
    const onSigterm = (): void => {
      requestStop("SIGTERM");
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("exit", onExit);
  });
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
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

async function stopCodeFoxProcess(
  stateFilePath: string,
  resolvedConfigPath: string,
  output: LocalCliOutput
): Promise<number> {
  const pidFilePath = relayPidFilePath(stateFilePath);
  const pid = await readRelayPid(pidFilePath);
  const candidatePids = new Set<number>();

  if (pid) {
    const alive = isProcessAlive(pid);
    if (!alive) {
      await removePidFile(pidFilePath);
      output.log(`Removed stale pid file ${pidFilePath} (pid ${pid} was not running).`);
    } else {
      const looksSafeToStop = await isLikelyCodeFoxProcess(pid);
      if (looksSafeToStop) {
        candidatePids.add(pid);
      } else {
        output.log(`Ignoring pid ${pid} from ${pidFilePath}: process does not look like CodeFox.`);
      }
    }
  }

  const fallbackPids = await findCodeFoxPidsByConfig(resolvedConfigPath);
  for (const fallbackPid of fallbackPids) {
    candidatePids.add(fallbackPid);
  }

  if (candidatePids.size === 0) {
    output.error(`No running CodeFox process found for config ${resolvedConfigPath}.`);
    output.log("If CodeFox was started manually in another terminal, stop it there.");
    return 1;
  }

  const sortedPids = [...candidatePids].sort((left, right) => left - right);
  let stoppedAny = false;
  for (const targetPid of sortedPids) {
    const stopResult = await stopProcessByPid(targetPid);
    if (stopResult.ok) {
      stoppedAny = true;
      output.log(`Stopped background CodeFox process pid ${targetPid}.`);
      continue;
    }
    output.error(`Failed to stop CodeFox pid ${targetPid}: ${stopResult.error ?? "unknown error"}.`);
  }

  if (!stoppedAny) {
    return 1;
  }

  await removePidFile(pidFilePath);
  return 0;
}

async function readRelayPid(pidFilePath: string): Promise<number | undefined> {
  try {
    const raw = await readFile(pidFilePath, "utf8");
    const parsed = Number(raw.trim());
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function stopProcessByPid(pid: number): Promise<{ ok: boolean; error?: string }> {
  if (!isProcessAlive(pid)) {
    return { ok: true };
  }
  try {
    process.kill(pid);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      return { ok: true };
    }
    return {
      ok: false,
      error: String(error)
    };
  }

  const stoppedGracefully = await waitForProcessExit(pid, 5000);
  if (stoppedGracefully) {
    return { ok: true };
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      return { ok: true };
    }
    return {
      ok: false,
      error: `did not stop gracefully and SIGKILL failed: ${String(error)}`
    };
  }
  const stoppedAfterKill = await waitForProcessExit(pid, 2000);
  if (!stoppedAfterKill) {
    return {
      ok: false,
      error: "still running after SIGKILL"
    };
  }
  return { ok: true };
}

async function isLikelyCodeFoxProcess(pid: number): Promise<boolean> {
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const normalized = cmdline.replace(/\u0000/g, " ");
    return normalized.includes("codefox") && (normalized.includes("src/index.ts") || normalized.includes("dist/index.js"));
  } catch {
    return true;
  }
}

async function findCodeFoxPidsByConfig(configPath: string): Promise<number[]> {
  if (process.platform !== "linux") {
    return [];
  }
  const resolvedConfigPath = path.resolve(configPath);
  const entries = await readdir("/proc", { withFileTypes: true }).catch(() => []);
  const matches: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (!cmdline) {
      continue;
    }
    const normalized = cmdline.replace(/\u0000/g, " ").trim();
    if (
      (normalized.includes("src/index.ts") || normalized.includes("dist/index.js")) &&
      normalized.includes(resolvedConfigPath)
    ) {
      matches.push(pid);
    }
  }
  return matches;
}

async function removePidFile(pidFilePath: string): Promise<void> {
  try {
    await unlink(pidFilePath);
  } catch {
    // Non-fatal cleanup.
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
    "CodeFox operator commands",
    "Local UI:",
    "  npm run ui                         (browser UI at http://127.0.0.1:8789)",
    "Handoff bridge:",
    "  npm run handoff:cli -- --config <path> [chatId] [--remaining <summary>] [options]",
    "    options: [--work-id <id>] [--completed <text>]... [--risk <text>]... [--question <text>]...",
    "             [--task <taskId>] [--client <id>] [--spec <revision>] [--completion-summary <text>] [--session-id <id>]",
    "             [--host <relay-host>] [--port <relay-port>] [--lease-seconds <n>] [--repo-path <path>]",
    "             [--start-in-foreground|--start-in-background|--no-start-if-missing]",
    "             [--start-if-missing]  (compat alias for --start-in-background)",
    "Stop background runtime:",
    "  npm run dev:stop -- --config <path>"
  ].join("\n");
}

function renderDashboard(
  sessions: Array<{
    chatId: number;
    selectedRepo?: string;
    mode: string;
    activeRequestId?: string;
    codexThreadId?: string;
    updatedAt: string;
  }>,
  approvals: Array<{
    id: string;
    chatId: number;
    source?: "codefox" | "external-codex";
    capabilityRef?: string;
    createdAt: string;
  }>,
  specWorkflows: PersistedSpecWorkflow[]
): string {
  const lines = [
    "Dashboard:",
    `summary: sessions=${sessions.length} approvals=${approvals.length} specs=${specWorkflows.length}`
  ];

  if (sessions.length === 0) {
    lines.push("chats: none");
  } else {
    lines.push("chats:");
    const sortedSessions = [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const session of sortedSessions) {
      const approval = approvals.find((entry) => entry.chatId === session.chatId);
      const spec = specWorkflows.find((entry) => entry.chatId === session.chatId);
      const revision = spec ? getCurrentRevision(spec.workflow) : undefined;
      lines.push(
        `- chat=${session.chatId} repo=${session.selectedRepo ?? "(none)"} mode=${session.mode} activeRequest=${session.activeRequestId ?? "none"} thread=${session.codexThreadId ?? "none"} updatedAt=${session.updatedAt}`
      );
      lines.push(
        `  approval=${
          approval
            ? `${approval.id} source=${approval.source ?? "codefox"} capability=${approval.capabilityRef ?? "(untyped)"} createdAt=${approval.createdAt}`
            : "none"
        }`
      );
      lines.push(
        `  spec=${
          revision
            ? `v${revision.version} stage=${revision.stage} status=${revision.status} updatedAt=${revision.updatedAt}`
            : "none"
        }`
      );
    }
  }

  const orphanApprovals = approvals.filter((entry) => !sessions.some((session) => session.chatId === entry.chatId));
  if (orphanApprovals.length > 0) {
    lines.push("orphan approvals:");
    for (const approval of orphanApprovals) {
      lines.push(
        `- id=${approval.id} chat=${approval.chatId} source=${approval.source ?? "codefox"} capability=${approval.capabilityRef ?? "(untyped)"} createdAt=${approval.createdAt}`
      );
    }
  }

  const orphanSpecs = specWorkflows.filter((entry) => !sessions.some((session) => session.chatId === entry.chatId));
  if (orphanSpecs.length > 0) {
    lines.push("orphan specs:");
    for (const spec of orphanSpecs) {
      const revision = getCurrentRevision(spec.workflow);
      lines.push(
        `- chat=${spec.chatId} version=v${revision.version} stage=${revision.stage} status=${revision.status} updatedAt=${revision.updatedAt}`
      );
    }
  }

  return lines.join("\n");
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
